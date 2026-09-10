const { createHmac } = require("crypto");
const { verifyZernioSignature, normalizeZernioEvent } = require("./zernioEvent");

const SECRET = "a".repeat(64);
const ACCOUNT = { zernio_account_id: "zacct_1", ig_user_id: "17841400000000000" };

function sign(body, secret = SECRET) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyZernioSignature", () => {
  const rawBody = JSON.stringify({ hello: "world" });

  it("accepts a correct signature", () => {
    expect(
      verifyZernioSignature({ rawBody, signature: sign(rawBody), secret: SECRET }),
    ).toBe(true);
  });

  it("accepts a Buffer body", () => {
    expect(
      verifyZernioSignature({
        rawBody: Buffer.from(rawBody, "utf8"),
        signature: sign(rawBody),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyZernioSignature({ rawBody, signature: sign(rawBody, "b".repeat(64)), secret: SECRET }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = sign(rawBody);
    expect(
      verifyZernioSignature({ rawBody: rawBody + " ", signature, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects a missing, malformed or wrong-length signature", () => {
    expect(verifyZernioSignature({ rawBody, signature: null, secret: SECRET })).toBe(false);
    expect(verifyZernioSignature({ rawBody, signature: "nothex", secret: SECRET })).toBe(false);
    expect(verifyZernioSignature({ rawBody, signature: "ab".repeat(10), secret: SECRET })).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    expect(verifyZernioSignature({ rawBody, signature: sign(rawBody), secret: "" })).toBe(false);
  });
});

describe("normalizeZernioEvent", () => {
  function commentPayload(overrides = {}) {
    return {
      id: "evt_1",
      event: "comment.received",
      account: { id: "zacct_1", platform: "instagram" },
      comment: {
        id: "comment_1",
        platformPostId: "media_1",
        text: "send me the guide",
        author: { id: "commenter_1", username: "someone" },
      },
      ...overrides,
    };
  }

  it("maps comment.received onto the Meta comments envelope", () => {
    const result = normalizeZernioEvent({ payload: commentPayload(), account: ACCOUNT });

    expect(result).toEqual({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT.ig_user_id,
          time: expect.any(Number),
          changes: [
            {
              field: "comments",
              value: {
                id: "comment_1",
                text: "send me the guide",
                from: { id: "commenter_1", username: "someone" },
                media: { id: "media_1" },
              },
            },
          ],
        },
      ],
    });
  });

  it("maps message.received onto the Meta messaging envelope", () => {
    const result = normalizeZernioEvent({
      payload: {
        id: "evt_2",
        event: "message.received",
        account: { id: "zacct_1", platform: "instagram" },
        message: {
          platformMessageId: "mid_1",
          direction: "incoming",
          text: "hey",
          sender: { id: "commenter_1" },
        },
      },
      account: ACCOUNT,
    });

    expect(result.entry[0].messaging[0]).toMatchObject({
      sender: { id: "commenter_1" },
      recipient: { id: ACCOUNT.ig_user_id },
      message: { mid: "mid_1", text: "hey" },
    });
  });

  it("ignores outgoing message echoes", () => {
    const result = normalizeZernioEvent({
      payload: {
        id: "evt_3",
        event: "message.received",
        account: { id: "zacct_1", platform: "instagram" },
        message: {
          platformMessageId: "mid_2",
          direction: "outgoing",
          text: "our reply",
          sender: { id: ACCOUNT.ig_user_id },
        },
      },
      account: ACCOUNT,
    });

    expect(result).toBeNull();
  });

  it("maps message.read onto a read receipt with the statusAt watermark", () => {
    const result = normalizeZernioEvent({
      payload: {
        id: "evt_4",
        event: "message.read",
        account: { id: "zacct_1", platform: "instagram" },
        conversation: { participantId: "commenter_1" },
        statusAt: "2026-09-10T10:00:00.000Z",
      },
      account: ACCOUNT,
    });

    expect(result.entry[0].messaging[0].read.watermark).toBe(
      Date.parse("2026-09-10T10:00:00.000Z"),
    );
  });

  it("rejects an event for a different Zernio account", () => {
    const payload = commentPayload({ account: { id: "zacct_other", platform: "instagram" } });
    expect(normalizeZernioEvent({ payload, account: ACCOUNT })).toBeNull();
  });

  it("rejects a non-Instagram platform", () => {
    const payload = commentPayload({ account: { id: "zacct_1", platform: "facebook" } });
    expect(normalizeZernioEvent({ payload, account: ACCOUNT })).toBeNull();
  });

  it("rejects unknown event types", () => {
    const payload = commentPayload({ event: "comment.deleted" });
    expect(normalizeZernioEvent({ payload, account: ACCOUNT })).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(normalizeZernioEvent({ payload: null, account: ACCOUNT })).toBeNull();
    expect(normalizeZernioEvent({ payload: {}, account: ACCOUNT })).toBeNull();
    expect(
      normalizeZernioEvent({ payload: commentPayload({ comment: { id: "c" } }), account: ACCOUNT }),
    ).toBeNull();
  });

  it("rejects when the account has no bound IG user id", () => {
    expect(
      normalizeZernioEvent({
        payload: commentPayload(),
        account: { zernio_account_id: "zacct_1", ig_user_id: null },
      }),
    ).toBeNull();
  });

  it("produces a payload the Meta comment handler can consume", () => {
    const result = normalizeZernioEvent({ payload: commentPayload(), account: ACCOUNT });
    const change = result.entry[0].changes[0];

    // Mirrors the shape processWebhookEvent destructures
    expect(result.object).toBe("instagram");
    expect(change.field).toBe("comments");
    expect(change.value.from.id).not.toBe(result.entry[0].id);
  });
});
