#!/usr/bin/env python3
"""
Instagram scraper using raw HTTP requests (no instagrapi).
Reads config from stdin (JSON), outputs progress as JSON lines to stdout.
Node.js spawns this script and reads the output to update DB / emit socket events.
"""

import json
import sys
import signal
import time
import random
import requests

# Delays in seconds
DELAY_FOLLOWER_PAGE = (5, 10)
DELAY_BIO_FETCH = (20, 35)
DELAY_ON_ERROR = (60, 120)
MAX_RETRIES = 5

BASE_URL = "https://i.instagram.com/api/v1"

terminated = False


def handle_signal(signum, frame):
    global terminated
    terminated = True


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def output(data):
    """Write a JSON line to stdout and flush."""
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        sys.exit(0)


def rand_delay(min_s, max_s):
    time.sleep(random.uniform(min_s, max_s))


def make_session(session_id, csrf_token, ds_user_id, proxy_url):
    """Create a requests.Session with browser-like headers and IG cookies."""
    s = requests.Session()

    s.headers.update({
        "user-agent": "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        "x-csrftoken": csrf_token,
        "x-ig-app-id": "936619743392459",
        "x-ig-www-claim": "0",
        "x-requested-with": "XMLHttpRequest",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "origin": "https://www.instagram.com",
        "referer": "https://www.instagram.com/",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
    })

    s.cookies.set("sessionid", session_id, domain=".instagram.com")
    s.cookies.set("csrftoken", csrf_token, domain=".instagram.com")
    s.cookies.set("ds_user_id", ds_user_id, domain=".instagram.com")

    if proxy_url:
        s.proxies = {"http": proxy_url, "https": proxy_url}

    return s


def ig_request(session, path, params=None):
    """Make a GET request to Instagram's private API. Returns parsed JSON or raises."""
    url = f"{BASE_URL}/{path}"
    resp = session.get(url, params=params, timeout=30)

    if resp.status_code == 401:
        raise SessionExpired("Session expired (401)")
    if resp.status_code == 400:
        # Instagram returns 400 for various errors — try to parse
        try:
            data = resp.json()
            msg = data.get("message", "")
            if "challenge_required" in msg or "checkpoint_required" in msg:
                raise SessionExpired(f"Challenge required: {msg}")
            if "login_required" in msg:
                raise SessionExpired(f"Login required: {msg}")
            raise ApiError(f"400: {msg}", resp.status_code)
        except (ValueError, KeyError):
            raise ApiError(f"400: {resp.text[:200]}", resp.status_code)
    if resp.status_code == 429:
        raise RateLimited("Rate limited (429)")
    if resp.status_code == 404:
        raise NotFound(f"Not found (404): {path}")
    if resp.status_code != 200:
        raise ApiError(f"HTTP {resp.status_code}: {resp.text[:200]}", resp.status_code)

    try:
        return resp.json()
    except ValueError:
        raise ApiError(f"Non-JSON response (len={len(resp.text)}): {resp.text[:200]}", resp.status_code)


class SessionExpired(Exception):
    pass

class RateLimited(Exception):
    pass

class NotFound(Exception):
    pass

class ApiError(Exception):
    def __init__(self, message, status_code=0):
        super().__init__(message)
        self.status_code = status_code


def main():
    # Read config from stdin
    raw = sys.stdin.read()
    if not raw:
        output({"event": "fatal", "message": "No config received on stdin"})
        sys.exit(1)

    config = json.loads(raw)

    session_id = config["session_id"]
    target_username = config["target_username"]
    max_followers = config.get("max_followers")

    # Resume state
    phase = config.get("phase", "full")  # "full" or "bios"
    cursor = config.get("cursor")
    followers = config.get("followers", [])
    start_bio_index = config.get("start_bio_index", 0)
    target_user_id = config.get("target_user_id")

    csrf_token = config.get("csrf_token", "")
    ds_user_id = config.get("ds_user_id", "")
    proxy_url = config.get("proxy")

    if proxy_url:
        masked = proxy_url.split("@")[-1] if "@" in proxy_url else proxy_url
        output({"event": "info", "message": f"Using proxy: {masked}"})

    # Create session
    session = make_session(session_id, csrf_token, ds_user_id, proxy_url)

    # Validate session
    try:
        data = ig_request(session, "accounts/current_user/", params={"edit": "true"})
        username = data.get("user", {}).get("username", f"uid:{ds_user_id}")
        output({"event": "session_valid", "username": username})
    except SessionExpired as e:
        output({"event": "fatal", "message": f"Session invalid: {e}. Update your Instagram cookies."})
        sys.exit(1)
    except RateLimited:
        # Validation endpoint rate-limited — cookies might still work, proceed
        output({"event": "info", "message": "Session validation rate-limited, proceeding anyway"})
    except Exception as e:
        # Non-fatal — cookies are set, try to proceed
        output({"event": "info", "message": f"Session validation failed ({e}), proceeding anyway"})

    # ========== Phase 1: Collect followers ==========
    if phase in ("full",):
        output({"event": "phase", "phase": "collecting_followers"})

        # Resolve user ID
        if not target_user_id:
            resolved = False
            for attempt in range(MAX_RETRIES):
                if terminated:
                    output({"event": "terminated"})
                    sys.exit(0)
                try:
                    data = ig_request(session, f"users/web_profile_info/", params={"username": target_username})
                    user_data = data.get("data", {}).get("user", {})
                    target_user_id = str(user_data.get("id", ""))
                    if not target_user_id:
                        raise ApiError("No user ID in response")
                    output({"event": "user_resolved", "user_id": target_user_id})
                    resolved = True
                    break
                except NotFound:
                    output({"event": "fatal", "message": f"User @{target_username} not found."})
                    sys.exit(1)
                except SessionExpired as e:
                    output({"event": "fatal", "message": f"Session expired during user lookup: {e}"})
                    sys.exit(1)
                except RateLimited:
                    wait = random.uniform(*DELAY_ON_ERROR) * (attempt + 1)
                    output({"event": "rate_limited", "context": "user_lookup", "wait": round(wait), "attempt": attempt + 1})
                    time.sleep(wait)
                except Exception as e:
                    if attempt == MAX_RETRIES - 1:
                        output({"event": "fatal", "message": f"Could not resolve @{target_username} after {MAX_RETRIES} attempts: {e}"})
                        sys.exit(1)
                    wait = random.uniform(*DELAY_ON_ERROR)
                    output({"event": "error", "message": str(e), "context": "user_lookup", "wait": round(wait)})
                    time.sleep(wait)

            if not resolved:
                output({"event": "fatal", "message": f"Could not resolve @{target_username} after {MAX_RETRIES} attempts"})
                sys.exit(1)

        # Paginate followers
        end_cursor = cursor

        while True:
            if terminated:
                output({"event": "terminated"})
                sys.exit(0)

            try:
                params = {"count": "50", "search_surface": "follow_list_page"}
                if end_cursor:
                    params["max_id"] = end_cursor

                result = ig_request(session, f"friendships/{target_user_id}/followers/", params=params)

                users = result.get("users", [])
                new_followers = []
                for u in users:
                    new_followers.append({
                        "pk": str(u.get("pk", "")),
                        "username": u.get("username", ""),
                        "full_name": u.get("full_name", ""),
                    })

                followers.extend(new_followers)
                end_cursor = result.get("next_max_id")

                output({
                    "event": "followers_page",
                    "new_count": len(new_followers),
                    "total": len(followers),
                    "cursor": end_cursor,
                    "users": new_followers,
                })

                if not end_cursor:
                    break

                if max_followers and len(followers) >= max_followers:
                    followers = followers[:max_followers]
                    break

                rand_delay(*DELAY_FOLLOWER_PAGE)

            except RateLimited:
                wait = random.uniform(*DELAY_ON_ERROR)
                output({"event": "rate_limited", "context": "followers", "wait": round(wait)})
                time.sleep(wait)
                continue

            except SessionExpired as e:
                output({"event": "fatal", "message": f"Session expired: {e}. Update your Instagram cookies and resume."})
                sys.exit(1)

            except Exception as e:
                wait = random.uniform(*DELAY_ON_ERROR)
                output({"event": "error", "message": str(e), "context": "followers", "wait": round(wait)})
                time.sleep(wait)
                continue

        output({"event": "followers_done", "total": len(followers)})

    # ========== Phase 2: Fetch bios ==========
    if phase in ("full", "bios"):
        output({"event": "phase", "phase": "fetching_bios"})

        total = len(followers)

        for i in range(start_bio_index, total):
            if terminated:
                output({"event": "terminated"})
                sys.exit(0)

            f = followers[i]

            for attempt in range(MAX_RETRIES):
                try:
                    data = ig_request(session, f"users/{f['pk']}/info/")
                    user_info = data.get("user", {})

                    bio_data = {
                        "biography": user_info.get("biography", ""),
                        "external_url": user_info.get("external_url", "") or "",
                        "follower_count": user_info.get("follower_count", 0) or 0,
                        "following_count": user_info.get("following_count", 0) or 0,
                        "is_private": user_info.get("is_private", False) or False,
                        "is_verified": user_info.get("is_verified", False) or False,
                        "category": user_info.get("category", "") or "",
                        "media_count": user_info.get("media_count", 0) or 0,
                    }

                    output({
                        "event": "bio_result",
                        "index": i,
                        "username": f["username"],
                        "bio_data": bio_data,
                    })
                    break  # success

                except RateLimited:
                    wait = random.uniform(*DELAY_ON_ERROR) * (attempt + 1)
                    output({
                        "event": "rate_limited",
                        "context": f"bio @{f['username']}",
                        "wait": round(wait),
                        "attempt": attempt + 1,
                    })
                    time.sleep(wait)

                except SessionExpired as e:
                    output({"event": "fatal", "message": f"Session expired: {e}. Update your Instagram cookies and resume."})
                    sys.exit(1)

                except NotFound:
                    output({
                        "event": "bio_skip",
                        "index": i,
                        "username": f["username"],
                        "reason": "User not found",
                    })
                    break  # skip, don't retry

                except Exception as e:
                    if attempt == MAX_RETRIES - 1:
                        output({
                            "event": "bio_skip",
                            "index": i,
                            "username": f["username"],
                            "reason": str(e),
                        })
                    else:
                        wait = random.uniform(*DELAY_ON_ERROR)
                        output({
                            "event": "error",
                            "message": str(e),
                            "context": f"bio @{f['username']}",
                            "wait": round(wait),
                        })
                        time.sleep(wait)

            if i < total - 1:
                rand_delay(*DELAY_BIO_FETCH)

    output({"event": "done"})


if __name__ == "__main__":
    main()
