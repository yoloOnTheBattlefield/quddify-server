const express = require("express");
const mongoose = require("mongoose");
const Account = require("../models/Account");
const Lead = require("../models/Lead");
const TrackingEvent = require("../models/TrackingEvent");

const router = express.Router();

// GET /t/script.js — serve the lightweight tracking script
router.get("/script.js", (req, res) => {
  res.set("Content-Type", "application/javascript");
  res.set("Cache-Control", "public, max-age=3600");

  const script = `(function(){
  var s = document.currentScript;
  if (!s) return;
  var accountId = s.getAttribute("data-account-id");
  if (!accountId) return;

  var base = s.src.replace(/\\/t\\/script\\.js.*$/, "");

  function post(path, body) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", base + path, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify(body));
    } catch(e) {}
  }

  function get(path, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", base + path, true);
      xhr.onload = function() {
        if (xhr.status === 200) {
          try { cb(JSON.parse(xhr.responseText)); } catch(e) {}
        }
      };
      xhr.send();
    } catch(e) {}
  }

  get("/t/config/" + accountId, function(cfg) {
    if (!cfg || !cfg.enabled) return;

    // Read utm_medium from URL
    var params = new URLSearchParams(window.location.search);
    var leadId = params.get("utm_medium");
    var lsKey = "qd_lead_" + accountId;

    if (leadId) {
      try { localStorage.setItem(lsKey, leadId); } catch(e) {}
    } else {
      try { leadId = localStorage.getItem(lsKey); } catch(e) {}
    }

    if (!leadId) return;

    var payload = {
      account_id: accountId,
      lead_id: leadId,
      url: window.location.href,
      referrer: document.referrer || null
    };

    // First visit (once per lead)
    var fvKey = "qd_fv_" + accountId + "_" + leadId;
    try {
      if (!localStorage.getItem(fvKey)) {
        payload.event_type = "first_visit";
        post("/t/event", payload);
        localStorage.setItem(fvKey, "1");
      }
    } catch(e) {}

    // Page view (every load)
    payload.event_type = "page_view";
    post("/t/event", payload);

    // Conversion check
    if (cfg.conversion_rules && cfg.conversion_rules.length > 0) {
      var cvKey = "qd_cv_" + accountId + "_" + leadId;
      try {
        if (!localStorage.getItem(cvKey)) {
          var url = window.location.href.toLowerCase();
          for (var i = 0; i < cfg.conversion_rules.length; i++) {
            if (url.indexOf(cfg.conversion_rules[i].toLowerCase()) !== -1) {
              payload.event_type = "conversion";
              post("/t/event", payload);
              localStorage.setItem(cvKey, "1");
              break;
            }
          }
        }
      } catch(e) {}
    }
  });
})();`;

  res.send(script);
});

// GET /t/config/:accountId — return tracking config
router.get("/config/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      return res.json({ enabled: false });
    }

    const account = await Account.findById(accountId, "tracking_enabled tracking_conversion_rules").lean();
    if (!account) {
      return res.json({ enabled: false });
    }

    res.json({
      enabled: !!account.tracking_enabled,
      conversion_rules: account.tracking_conversion_rules || [],
    });
  } catch (err) {
    console.error("Tracking config error:", err);
    res.json({ enabled: false });
  }
});

// POST /t/event — receive tracking events
router.post("/event", async (req, res) => {
  try {
    const { account_id, lead_id, event_type, url, referrer } = req.body;

    if (!account_id || !lead_id || !event_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!mongoose.Types.ObjectId.isValid(account_id)) {
      return res.status(400).json({ error: "Invalid account_id" });
    }

    if (!["first_visit", "page_view", "conversion"].includes(event_type)) {
      return res.status(400).json({ error: "Invalid event_type" });
    }

    // Server-side dedup for first_visit and conversion
    if (event_type === "first_visit" || event_type === "conversion") {
      const existing = await TrackingEvent.findOne({
        account_id,
        lead_id,
        event_type,
      }).lean();
      if (existing) {
        return res.json({ ok: true, deduped: true });
      }
    }

    await TrackingEvent.create({
      account_id,
      lead_id,
      event_type,
      url: url || null,
      referrer: referrer || null,
      user_agent: req.headers["user-agent"] || null,
    });

    // On conversion, set booked_at on the lead
    // lead_id (from utm_medium) can be the lead's _id or contact_id
    if (event_type === "conversion") {
      const idQuery = mongoose.Types.ObjectId.isValid(lead_id)
        ? { $or: [{ _id: lead_id }, { contact_id: lead_id }] }
        : { contact_id: lead_id };
      await Lead.findOneAndUpdate(
        { ...idQuery, booked_at: null },
        { $set: { booked_at: new Date() } },
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Tracking event error:", err);
    res.status(500).json({ error: "Failed to store event" });
  }
});

module.exports = router;
