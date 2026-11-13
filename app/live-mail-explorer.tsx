"use client";

import { Inbox, LoaderCircle, MailOpen, Search, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

export type LiveAccountOption = Readonly<{
  id: string;
  address: string;
  paused: boolean;
}>;

type SearchResult = Readonly<{
  id: string;
  accountId: string;
  accountAddress: string;
  threadId: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string;
}>;

const ALL_INBOXES = "__all_inboxes__";

type MessageResult = SearchResult & Readonly<{
  to: string | null;
  cc: string | null;
  bodyText: string;
  bodyTruncated: boolean;
}>;

const safeError = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

export function LiveMailExplorer({
  accounts,
  onAccountRecovered,
}: {
  accounts: readonly LiveAccountOption[];
  onAccountRecovered?: (accountId: string) => void;
}) {
  const available = accounts.filter((account) => !account.paused);
  const [accountId, setAccountId] = useState(
    available.length > 1 ? ALL_INBOXES : available[0]?.id ?? "",
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [selected, setSelected] = useState<MessageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const effectiveAccountId =
    (accountId === ALL_INBOXES || accountId === "") && available.length > 1
      ? ALL_INBOXES
      : available.some((account) => account.id === accountId)
        ? accountId
        : available[0]?.id ?? "";

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!effectiveAccountId || !query.trim()) return;
    setLoading(true);
    setError("");
    setSelected(null);
    try {
      const targets =
        effectiveAccountId === ALL_INBOXES
          ? available
          : available.filter((account) => account.id === effectiveAccountId);
      const outcomes = await Promise.all(targets.map(async (account) => {
        const response = await fetch("/api/mail/search", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            account_id: account.id,
            q: query.trim(),
            max_results: 20,
          }),
        });
        if (!response.ok) {
          return { account, results: [] as SearchResult[], error: await safeError(response) };
        }
        const payload = (await response.json()) as {
          results: Omit<SearchResult, "accountId" | "accountAddress">[];
        };
        return {
          account,
          results: payload.results.map((message) => ({
            ...message,
            accountId: account.id,
            accountAddress: account.address,
          })),
          error: "",
        };
      }));
      const successfulResults = outcomes
        .flatMap((outcome) => outcome.results)
        .sort((a, b) => Date.parse(b.date ?? "") - Date.parse(a.date ?? ""));
      const failures = outcomes.filter((outcome) => outcome.error);
      if (failures.length === outcomes.length) {
        throw new Error(failures[0]?.error || "Search failed");
      }
      outcomes
        .filter((outcome) => !outcome.error)
        .forEach((outcome) => onAccountRecovered?.(outcome.account.id));
      setResults(successfulResults);
      if (failures.length > 0) {
        setError(
          `${failures.length} inbox${failures.length === 1 ? "" : "es"} could not be searched; showing the rest.`,
        );
      }
    } catch (caught) {
      setResults([]);
      setError(caught instanceof Error ? caught.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const openMessage = async (message: SearchResult) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ account_id: message.accountId });
      const response = await fetch(
        `/api/mail/messages/${encodeURIComponent(message.id)}?${params}`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error(await safeError(response));
      const payload = (await response.json()) as {
        message: Omit<MessageResult, "accountId" | "accountAddress">;
      };
      setSelected({
        ...payload.message,
        accountId: message.accountId,
        accountAddress: message.accountAddress,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Message retrieval failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel live-mail">
      <div className="live-mail-head">
        <div>
          <p className="kicker"><ShieldCheck size={13}/> LIVE PROVIDER ACCESS</p>
          <h2>Live mailbox search without a local index.</h2>
          <p>Queries and message content are fetched just in time and excluded from InboxPort&apos;s normal audit data.</p>
        </div>
        <span><i/> read-only</span>
      </div>

      <form className="live-search" onSubmit={search}>
        <select
          aria-label="Mail account"
          value={effectiveAccountId}
          onChange={(event) => {
            setAccountId(event.target.value);
            setResults([]);
            setSelected(null);
            setError("");
          }}
          disabled={loading || available.length === 0}
        >
          {available.length > 1 && <option value={ALL_INBOXES}>All inboxes ({available.length})</option>}
          {available.map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
        </select>
        <label><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={512} placeholder="Try: quarterly report"/></label>
        <button disabled={loading || !effectiveAccountId || !query.trim()}>{loading ? <LoaderCircle className="spin"/> : <Search/>} {effectiveAccountId === ALL_INBOXES ? "Search all" : "Search mail"}</button>
      </form>

      {accounts.length === 0
        ? <div className="live-empty"><Inbox/><span><b>No inboxes connected.</b> Connect a Gmail or Outlook account from the Inboxes tab first.</span></div>
        : available.length === 0 && <div className="live-empty"><Inbox/><span><b>Every connected account is paused.</b> Resume an account before searching.</span></div>}
      {error && <div className="live-error">{error}</div>}

      {(results.length > 0 || selected) && <div className="mail-browser">
        <div className="mail-results">
          {results.map((message) => <button key={`${message.accountId}:${message.id}`} className={selected?.id === message.id && selected.accountId === message.accountId ? "selected" : ""} onClick={() => openMessage(message)}>
            <MailOpen/>
            <span><b>{message.subject || "(No subject)"}</b><small>{message.from || "Unknown sender"} · {message.accountAddress}</small><p>{message.snippet}</p></span>
          </button>)}
        </div>
        <article className="message-preview">
          {selected ? <>
            <p className="kicker">MESSAGE PREVIEW</p>
            <h3>{selected.subject || "(No subject)"}</h3>
            <dl><div><dt>From</dt><dd>{selected.from || "Unknown"}</dd></div><div><dt>To</dt><dd>{selected.to || "Unknown"}</dd></div>{selected.cc && <div><dt>Cc</dt><dd>{selected.cc}</dd></div>}</dl>
            <pre>{selected.bodyText || "No readable text body was returned."}</pre>
            {selected.bodyTruncated && <small className="truncated">Preview truncated at the configured safety limit.</small>}
          </> : <div className="message-placeholder"><MailOpen/><span>Select a result to retrieve its body.</span></div>}
        </article>
      </div>}
    </section>
  );
}
