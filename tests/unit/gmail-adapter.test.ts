import assert from "node:assert/strict";
import test from "node:test";
import { GmailApiError, GmailAdapter } from "../../lib/relay/providers/gmail.ts";

const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64url");

test("Gmail search retrieves bounded metadata without persisting content", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-token");
    if (url.includes("/messages?")) {
      return Response.json({ messages: [{ id: "m1", threadId: "t1" }] });
    }
    return Response.json({
      id: "m1",
      threadId: "t1",
      snippet: "short preview",
      labelIds: ["INBOX"],
      internalDate: "123",
      payload: {
        headers: [
          { name: "From", value: "Sender <sender@example.com>" },
          { name: "Subject", value: "Test message" },
          { name: "Date", value: "Tue, 21 Jul 2026 12:00:00 +0000" },
        ],
      },
    });
  };

  const adapter = new GmailAdapter(fetcher);
  const results = await adapter.search("access-token", "newer_than:7d", 20);
  assert.equal(results.length, 1);
  assert.equal(results[0].subject, "Test message");
  assert.match(requests[0], /q=newer_than%3A7d/);
  assert.match(requests[1], /format=metadata/);
});

test("Gmail message extraction returns plaintext and enforces byte limit", async () => {
  const adapter = new GmailAdapter(async () => Response.json({
    id: "m1",
    threadId: "t1",
    snippet: "preview",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: "Long message" },
      ],
      parts: [{ mimeType: "text/plain", body: { data: encoded("abcdefghij") } }],
    },
  }));

  const message = await adapter.getMessage("access-token", "m1", 5);
  assert.equal(message.bodyText, "abcde");
  assert.equal(message.bodyTruncated, true);
});

test("Gmail draft creation sends a well-formed MIME message and never a send call", async () => {
  const requests: Array<{ url: string; method: string | undefined; body: string | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body as string | undefined });
    return Response.json({ id: "draft_1", message: { id: "m_draft_1", threadId: "t1" } });
  };
  const adapter = new GmailAdapter(fetcher);

  const result = await adapter.createDraft("access-token", {
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: { format: "text", content: "Body text" },
  });

  assert.equal(result.draftId, "draft_1");
  assert.equal(result.providerMessageId, "m_draft_1");
  assert.equal(result.threadId, "t1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /\/drafts$/);

  const payload = JSON.parse(requests[0].body!) as { message: { raw: string } };
  const rawBase64 = payload.message.raw.replace(/-/g, "+").replace(/_/g, "/");
  const mime = Buffer.from(rawBase64, "base64").toString("utf-8");
  assert.match(mime, /^To: a@example\.com/m);
  assert.match(mime, /^Subject: Hello/m);
  assert.match(mime, /^Content-Type: text\/plain; charset="UTF-8"/m);
  // `text/text` is not a registered media type: Gmail cannot render it inline
  // and degrades the body to an unnamed attachment. This assertion previously
  // encoded that defect as expected behavior, so it must stay inverted.
  assert.doesNotMatch(mime, /text\/text/);
  assert.doesNotMatch(requests[0].url, /send/i);
});

/**
 * Reported bug investigation found Outlook's reply path was broken --
 * setting In-Reply-To/References as a Graph-side property Graph rejects on
 * a generic create call. Gmail's own path was never asserted this way; it
 * only ever passed threadId through as a static test fixture, never proving
 * the headers or threadId actually reach the request. This proves Gmail's
 * documented behavior (raw RFC 5322 headers plus an API-level threadId
 * field) rather than assuming it works because it happens to be simpler
 * than Outlook's case.
 */
test("a reply draft carries In-Reply-To/References in the MIME headers and threadId in the request body", async () => {
  const requests: Array<{ body: string | undefined }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push({ body: init?.body as string | undefined });
    return Response.json({ id: "draft_1", message: { id: "m_draft_1", threadId: "t1" } });
  };
  const adapter = new GmailAdapter(fetcher);

  await adapter.createDraft("access-token", {
    to: ["person@example.net"],
    cc: [],
    bcc: [],
    subject: "Re: Contract",
    body: { format: "text", content: "Sounds good." },
    inReplyTo: "original-message-id@mail.gmail.com",
    threadId: "t1",
  });

  const payload = JSON.parse(requests[0].body!) as { message: { raw: string; threadId?: string } };
  assert.equal(payload.message.threadId, "t1");

  const rawBase64 = payload.message.raw.replace(/-/g, "+").replace(/_/g, "/");
  const mime = Buffer.from(rawBase64, "base64").toString("utf-8");
  assert.match(mime, /^In-Reply-To: original-message-id@mail\.gmail\.com/m);
  assert.match(mime, /^References: original-message-id@mail\.gmail\.com/m);
});

test("Gmail draft update targets the existing draft id and never sends", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    return Response.json({ id: "draft_1", message: { id: "m_draft_2", threadId: "t1" } });
  };
  const adapter = new GmailAdapter(fetcher);

  const result = await adapter.updateDraft("access-token", "draft_1", {
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "Updated",
    body: { format: "text", content: "Updated body" },
  });

  assert.equal(result.providerMessageId, "m_draft_2");
  assert.equal(requests[0].method, "PUT");
  assert.match(requests[0].url, /\/drafts\/draft_1$/);
});

/**
 * Reshapes a raw RFC 2045 message into the `payload` object the Gmail drafts
 * API returns, so a draft we construct can be read back through our own
 * parser. The mimeType is taken from the Content-Type header we emitted --
 * that is the coupling under test: a subtype `collectBodies` does not
 * recognize yields an empty body, which is precisely how `text/text` shipped
 * a draft whose content Gmail could only render as an unnamed attachment.
 */
const rawToGmailPayload = (mime: string) => {
  const separator = mime.indexOf("\r\n\r\n");
  const headers = mime.slice(0, separator).split("\r\n").map((line) => {
    const colon = line.indexOf(": ");
    return { name: line.slice(0, colon), value: line.slice(colon + 2) };
  });
  const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  const body = mime.slice(separator + 4).replace(/\r\n/g, "");
  return {
    mimeType: contentType.split(";")[0].trim().toLowerCase(),
    filename: "",
    headers,
    body: { data: body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") },
  };
};

const createThenFetchDraft = async (format: "text" | "html", content: string) => {
  let raw = "";
  const adapter = new GmailAdapter(async (input, init) => {
    if (String(input).endsWith("/drafts")) {
      raw = (JSON.parse(init!.body as string) as { message: { raw: string } }).message.raw;
      return Response.json({ id: "draft_1", message: { id: "m_1", threadId: "t1" } });
    }
    const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    return Response.json({
      id: "draft_1",
      message: { id: "m_1", threadId: "t1", payload: rawToGmailPayload(mime) },
    });
  });

  await adapter.createDraft("access-token", {
    to: ["person@example.net"],
    cc: [],
    bcc: [],
    subject: "Round trip",
    body: { format, content },
  });
  return adapter.getDraft("access-token", "draft_1");
};

test("a created plaintext draft reads back with a populated body and no attachments", async () => {
  const draft = await createThenFetchDraft("text", "Body the recipient must actually see.");

  assert.equal(draft.bodyText, "Body the recipient must actually see.");
  assert.equal(draft.hasAttachments, false);
  assert.equal(draft.subject, "Round trip");
});

test("a created HTML draft reads back as HTML with no attachments", async () => {
  const draft = await createThenFetchDraft("html", "<p>Body the recipient must actually see.</p>");

  assert.equal(draft.bodyHtml, "<p>Body the recipient must actually see.</p>");
  assert.equal(draft.bodyText, "");
  assert.equal(draft.hasAttachments, false);
});

/**
 * The approval envelope hashes the body read back from the provider, so a body
 * that does not survive the round trip is not merely a rendering bug: the human
 * approves a preview showing no content while the draft still carries it.
 */
test("a body that survives the round trip is what the send preview can hash", async () => {
  const draft = await createThenFetchDraft("text", "Wire $5,000 to account 12345.");

  assert.notEqual(draft.bodyText, "");
  assert.match(draft.bodyText, /Wire \$5,000/);
});

test("getDraft captures From and both text/html alternatives for exact hashing", async () => {
  const adapter = new GmailAdapter(async () =>
    Response.json({
      id: "draft_1",
      message: {
        id: "m_1",
        threadId: "t1",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: "Me <me@example.com>" },
            { name: "To", value: "person@example.net" },
            { name: "Subject", value: "Hi" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: encoded("plain version") } },
            { mimeType: "text/html", body: { data: encoded("<p>html version</p>") } },
          ],
        },
      },
    }),
  );

  const draft = await adapter.getDraft("access-token", "draft_1");
  assert.equal(draft.from, "Me <me@example.com>");
  assert.equal(draft.bodyText, "plain version");
  assert.equal(draft.bodyHtml, "<p>html version</p>");
  assert.equal(draft.hasAttachments, false);
});

test("getDraft flags an attachment that has no filename (attachmentId / disposition)", async () => {
  const adapter = new GmailAdapter(async () =>
    Response.json({
      id: "draft_2",
      message: {
        id: "m_2",
        threadId: null,
        payload: {
          mimeType: "multipart/mixed",
          headers: [{ name: "Subject", value: "With inline" }],
          parts: [
            { mimeType: "text/plain", body: { data: encoded("see attached") } },
            {
              mimeType: "image/png",
              headers: [{ name: "Content-Disposition", value: "attachment" }],
              body: { size: 1024, attachmentId: "att_1" },
            },
          ],
        },
      },
    }),
  );

  const draft = await adapter.getDraft("access-token", "draft_2");
  assert.equal(draft.hasAttachments, true);
});

test("an oversized text/plain body part delivered via attachmentId is not misread as an attachment", async () => {
  // Gmail sets attachmentId (and omits inline body.data) for ANY part too large to
  // inline in the response -- a long plaintext digest just as much as a real
  // attachment. Without a filename or Content-Disposition: attachment, this must
  // stay a body part, not trip ATTACHMENTS_NOT_SUPPORTED_IN_MVP for a message that
  // never had a real attachment.
  const adapter = new GmailAdapter(async (input) => {
    if (String(input).includes("/attachments/")) {
      return Response.json({ size: 5_000_000, data: encoded("the full long digest") });
    }
    return Response.json({
      id: "draft_3",
      message: {
        id: "m_3",
        threadId: "t1",
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Subject", value: "A very long digest" }],
          body: { size: 5_000_000, attachmentId: "att_big_body" },
        },
      },
    });
  });

  const draft = await adapter.getDraft("access-token", "draft_3");
  assert.equal(draft.hasAttachments, false);
  assert.equal(draft.bodyText, "the full long digest");
});

test("getMessage fetches an oversized body part via its attachmentId instead of dropping it", async () => {
  const requests: string[] = [];
  const adapter = new GmailAdapter(async (input) => {
    requests.push(String(input));
    if (String(input).includes("/attachments/")) {
      return Response.json({ size: 5_000_000, data: encoded("the full long digest") });
    }
    return Response.json({
      id: "m_1",
      threadId: "t1",
      internalDate: "1000",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { size: 5_000_000, attachmentId: "att_big_body" },
      },
    });
  });

  const message = await adapter.getMessage("access-token", "m_1", 1_000_000);
  assert.equal(message.bodyText, "the full long digest");
  assert.ok(requests.some((url) => url.includes("/messages/m_1/attachments/att_big_body")));
});

test("a fetch failure for an oversized body part throws rather than silently returning incomplete content", async () => {
  const adapter = new GmailAdapter(async (input) => {
    if (String(input).includes("/attachments/")) {
      return new Response(null, { status: 500 });
    }
    return Response.json({
      id: "m_1",
      threadId: "t1",
      internalDate: "1000",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { size: 5_000_000, attachmentId: "att_big_body" },
      },
    });
  });

  await assert.rejects(
    () => adapter.getMessage("access-token", "m_1", 1_000_000),
    (error: unknown) => error instanceof GmailApiError,
  );
});

test("Gmail upstream errors are reduced to safe error classes", async () => {
  const adapter = new GmailAdapter(async () =>
    Response.json(
      { error: { message: "provider response containing a private token" } },
      { status: 429 },
    ),
  );
  await assert.rejects(
    () => adapter.getProfile("access-token"),
    (error: unknown) => {
      assert.ok(error instanceof GmailApiError);
      assert.equal(error.code, "RATE_LIMITED");
      assert.doesNotMatch(error.message, /private token/);
      return true;
    },
  );
});
