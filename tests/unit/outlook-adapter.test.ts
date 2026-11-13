import assert from "node:assert/strict";
import test from "node:test";
import { OutlookAdapter, OutlookApiError } from "../../lib/relay/providers/outlook.ts";

test("Outlook search retrieves bounded metadata via Graph $search", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-token");
    return Response.json({
      value: [
        {
          id: "m1",
          conversationId: "t1",
          subject: "Test message",
          bodyPreview: "short preview",
          receivedDateTime: "2026-07-22T12:00:00Z",
          from: { emailAddress: { address: "sender@example.com" } },
        },
      ],
    });
  };

  const adapter = new OutlookAdapter(fetcher);
  const results = await adapter.search("access-token", "newer_than:7d", 20);
  assert.equal(results.length, 1);
  assert.equal(results[0].subject, "Test message");
  assert.equal(results[0].threadId, "t1");
  assert.match(requests[0], /%24search=/);
});

test("Outlook message extraction converts HTML bodies and enforces byte limit", async () => {
  const adapter = new OutlookAdapter(async () =>
    Response.json({
      id: "m1",
      conversationId: "t1",
      subject: "Long message",
      from: { emailAddress: { address: "sender@example.com" } },
      toRecipients: [{ emailAddress: { address: "me@example.com" } }],
      body: { contentType: "html", content: "<p>abcdefghij</p>" },
    }),
  );

  const message = await adapter.getMessage("access-token", "m1", 5);
  assert.equal(message.bodyText, "abcde");
  assert.equal(message.bodyTruncated, true);
  assert.equal(message.to, "me@example.com");
});

test("Outlook thread retrieval groups messages by conversationId", async () => {
  const requests: string[] = [];
  const adapter = new OutlookAdapter(async (input) => {
    requests.push(String(input));
    return Response.json({
      value: [
        { id: "m1", conversationId: "t1", subject: "First", body: { contentType: "text", content: "one" } },
        { id: "m2", conversationId: "t1", subject: "Second", body: { contentType: "text", content: "two" } },
      ],
    });
  });

  const thread = await adapter.getThread("access-token", "t1", 500_000);
  assert.equal(thread.messages.length, 2);
  assert.match(requests[0], /conversationId\+eq\+%27t1%27/);
});

test("Outlook draft creation POSTs a JSON message and never a send call", async () => {
  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Response.json({ id: "draft_1", conversationId: "conv_1" });
  };
  const adapter = new OutlookAdapter(fetcher);

  const result = await adapter.createDraft("access-token", {
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: { format: "text", content: "Body text" },
  });

  assert.equal(result.draftId, "draft_1");
  assert.equal(result.providerMessageId, "draft_1");
  assert.equal(result.threadId, "conv_1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /\/me\/messages$/);
  const body = requests[0].body as { subject: string; body: { contentType: string } };
  assert.equal(body.subject, "Hello");
  assert.equal(body.body.contentType, "Text");
  assert.doesNotMatch(requests[0].url, /\/send/);
});

/**
 * Reproduces the reported bug: a plain POST /me/messages with hand-set
 * In-Reply-To/References headers is what Graph was rejecting (those are
 * transport-managed headers Graph does not let a client set this way). The
 * fix routes a reply through Graph's dedicated createReply endpoint, which
 * documents that it preserves the original message's conversationId on the
 * new draft -- simulated here since there is no live Graph account in this
 * suite. This does not prove Graph's real API behaves exactly as
 * documented; it proves the adapter calls the right endpoint with the right
 * override and maps the response correctly if Graph does.
 */
test("a reply draft is created via Graph's createReply endpoint and inherits the original conversationId", async () => {
  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    // Graph's documented createReply behavior: the new draft inherits the
    // original message's conversationId.
    return Response.json({ id: "reply_draft_1", conversationId: "conv_original" });
  };
  const adapter = new OutlookAdapter(fetcher);

  const result = await adapter.createDraft("access-token", {
    to: ["person@example.net"],
    cc: [],
    bcc: [],
    subject: "Re: Contract",
    body: { format: "text", content: "Sounds good." },
    inReplyTo: "original_message_1",
    threadId: "conv_original",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /\/me\/messages\/original_message_1\/createReply$/);
  assert.doesNotMatch(requests[0].url, /internetMessageHeaders/);

  // The override must carry Relay's exact content -- not Graph's
  // auto-populated recipients/subject/quoted body -- and must not attempt
  // to set the transport-managed headers that caused the original failure.
  const body = requests[0].body as { message: { subject: string; toRecipients: unknown[] }; internetMessageHeaders?: unknown };
  assert.equal(body.message.subject, "Re: Contract");
  assert.equal(body.message.toRecipients.length, 1);
  assert.equal(body.internetMessageHeaders, undefined);

  assert.equal(result.threadId, "conv_original");
  assert.equal(result.draftId, "reply_draft_1");
});

/**
 * Unlike Gmail (which threads purely on a bare threadId), Graph has no way to
 * attach a new message to an existing conversation without a specific source
 * message id -- only createReply/createReplyAll/createForward do that, and
 * all three need inReplyTo. threadId with no inReplyTo must fail loudly
 * rather than silently create a plain, unthreaded draft while still
 * reporting success.
 */
test("creating an Outlook draft with threadId but no inReplyTo is rejected, not silently unthreaded", async () => {
  const requests: string[] = [];
  const adapter = new OutlookAdapter(async (input) => {
    requests.push(String(input));
    return Response.json({ id: "draft_1", conversationId: "conv_1" });
  });

  await assert.rejects(
    () =>
      adapter.createDraft("access-token", {
        to: ["person@example.net"],
        cc: [],
        bcc: [],
        subject: "Re: Contract",
        body: { format: "text", content: "Sounds good." },
        threadId: "conv_original",
      }),
    (error: unknown) => error instanceof OutlookApiError && error.code === "THREADING_REQUIRES_MESSAGE_ID",
  );
  assert.equal(requests.length, 0);
});

test("a reply draft update PATCHes without attempting to set threading headers", async () => {
  const requests: Array<{ body: unknown }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
    return Response.json({ id: "reply_draft_1", conversationId: "conv_original" });
  };
  const adapter = new OutlookAdapter(fetcher);

  await adapter.updateDraft("access-token", "reply_draft_1", {
    to: ["person@example.net"],
    cc: [],
    bcc: [],
    subject: "Re: Contract (edited)",
    body: { format: "text", content: "Actually, let's push the date." },
    inReplyTo: "original_message_1",
    threadId: "conv_original",
  });

  const body = requests[0].body as { internetMessageHeaders?: unknown; subject: string };
  assert.equal(body.internetMessageHeaders, undefined);
  assert.equal(body.subject, "Re: Contract (edited)");
});

test("Outlook draft update PATCHes the existing draft id and never sends", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    return Response.json({ id: "draft_1", conversationId: "conv_1" });
  };
  const adapter = new OutlookAdapter(fetcher);

  const result = await adapter.updateDraft("access-token", "draft_1", {
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "Updated",
    body: { format: "text", content: "Updated body" },
  });

  assert.equal(result.providerMessageId, "draft_1");
  assert.equal(requests[0].method, "PATCH");
  assert.match(requests[0].url, /\/me\/messages\/draft_1$/);
});

/**
 * Feeds a created draft's own POST body back through getDraft's own parser,
 * the same discipline that caught the Gmail MIME subtype bug earlier this
 * session: build via the real adapter, read back via the real adapter, never
 * hand-construct the "expected" shape. Graph is JSON, not MIME, so there is
 * no content-type-subtype class of bug here -- but a wrong field mapping
 * (e.g. reading bodyPreview instead of body.content) would still only be
 * caught by an actual round trip, not by asserting on the request body alone.
 */
const createThenFetchOutlookDraft = async (
  format: "text" | "html",
  content: string,
  hasAttachments = false,
) => {
  let created: Record<string, unknown> = {};
  const adapter = new OutlookAdapter(async (input, init) => {
    if (String(input).endsWith("/me/messages")) {
      created = { id: "draft_1", conversationId: "conv_1", ...JSON.parse(init!.body as string) };
      return Response.json(created);
    }
    return Response.json({ ...created, hasAttachments });
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

test("a created plaintext Outlook draft reads back with a populated body and no attachments", async () => {
  const draft = await createThenFetchOutlookDraft("text", "Body the recipient must actually see.");
  assert.equal(draft.bodyText, "Body the recipient must actually see.");
  assert.equal(draft.bodyHtml, "");
  assert.equal(draft.hasAttachments, false);
  assert.equal(draft.subject, "Round trip");
});

test("a created HTML Outlook draft reads back as HTML with no attachments", async () => {
  const draft = await createThenFetchOutlookDraft("html", "<p>Body the recipient must actually see.</p>");
  assert.equal(draft.bodyHtml, "<p>Body the recipient must actually see.</p>");
  assert.equal(draft.bodyText, "");
  assert.equal(draft.hasAttachments, false);
});

test("an Outlook draft round trip reflects hasAttachments honestly when Graph reports one", async () => {
  const draft = await createThenFetchOutlookDraft("text", "See attached.", true);
  assert.equal(draft.hasAttachments, true);
});

/**
 * Codex audit finding: unlike Gmail (which ORs three independent signals --
 * filename/attachmentId/Content-Disposition -- because no single one is
 * trusted alone), Outlook's getDraft relied solely on Graph's self-reported
 * hasAttachments flag. getDraft now also requests $expand=attachments and
 * ORs its own presence in. This proves the cross-check actually does
 * something: hasAttachments says false, but the expanded collection is
 * non-empty, and the adapter must still report true (fail closed).
 */
test("getDraft trusts the expanded attachments collection even if hasAttachments under-reports", async () => {
  const adapter = new OutlookAdapter(async () =>
    Response.json({
      id: "draft_1",
      conversationId: "conv_1",
      subject: "Has a hidden attachment",
      hasAttachments: false,
      attachments: [{ id: "att_1" }],
    }),
  );

  const draft = await adapter.getDraft("access-token", "draft_1");
  assert.equal(draft.hasAttachments, true);
});

/**
 * Documented Graph inconsistency: an inline-only attachment can leave BOTH
 * hasAttachments false and the expanded attachments collection empty (see
 * microsoftgraph/msgraph-sdk-dotnet#1683). A cid: reference in the HTML body
 * is the third, independent signal that survives that gap.
 */
test("getDraft detects an inline attachment via a cid: reference even when both other signals are absent", async () => {
  const adapter = new OutlookAdapter(async () =>
    Response.json({
      id: "draft_1",
      conversationId: "conv_1",
      subject: "Has only an inline image",
      hasAttachments: false,
      attachments: [],
      body: { contentType: "html", content: '<p>See below</p><img src="cid:image001.png">' },
    }),
  );

  const draft = await adapter.getDraft("access-token", "draft_1");
  assert.equal(draft.hasAttachments, true);
});

test("getDraft requests the expanded attachments collection", async () => {
  const requests: string[] = [];
  const adapter = new OutlookAdapter(async (input) => {
    requests.push(String(input));
    return Response.json({ id: "draft_1", conversationId: "conv_1" });
  });

  await adapter.getDraft("access-token", "draft_1");
  assert.match(requests[0], /\$expand=attachments/);
});

test("Outlook send POSTs to the draft's own send endpoint and tolerates Graph's empty 202 body", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const adapter = new OutlookAdapter(async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    // Graph documents 202 Accepted with no response body on success.
    return new Response(null, { status: 202 });
  });

  const result = await adapter.sendDraft("access-token", "draft_1");
  assert.equal(result.providerMessageId, "draft_1");
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /\/me\/messages\/draft_1\/send$/);
});

test("send and getDraft both request Graph's immutable id format, since send moves the message between folders", async () => {
  const preferHeaders: Array<string | null> = [];

  const sendAdapter = new OutlookAdapter(async (_input, init) => {
    preferHeaders.push(new Headers(init?.headers).get("prefer"));
    return new Response(null, { status: 202 });
  });
  await sendAdapter.sendDraft("access-token", "draft_1");

  const getDraftAdapter = new OutlookAdapter(async (_input, init) => {
    preferHeaders.push(new Headers(init?.headers).get("prefer"));
    return Response.json({ id: "draft_1", conversationId: "conv_1" });
  });
  await getDraftAdapter.getDraft("access-token", "draft_1");

  assert.deepEqual(preferHeaders, ['IdType="ImmutableId"', 'IdType="ImmutableId"']);
});

test("Outlook upstream errors are reduced to safe error classes", async () => {
  const adapter = new OutlookAdapter(async () =>
    Response.json(
      { error: { code: "TooManyRequests", message: "provider response containing a private detail" } },
      { status: 429 },
    ),
  );
  await assert.rejects(
    () => adapter.getProfile("access-token"),
    (error: unknown) => {
      assert.ok(error instanceof OutlookApiError);
      assert.equal(error.code, "RATE_LIMITED");
      assert.doesNotMatch(error.message, /private detail/);
      return true;
    },
  );
});
