"use client";

import { Show, UserButton } from "@clerk/nextjs";
import {
  Activity, AlertTriangle, ArrowRight, Bot, Check, Copy, Eye, EyeOff,
  Fingerprint, Inbox, KeyRound, LockKeyhole, Mail, MailCheck, Menu, MessageSquareText,
  Pause, Play, PlugZap, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck,
  SlidersHorizontal, Unplug, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  filterAuditEvents,
  mapPublicAccounts,
  presentAuditEvent,
  serializeAuditEvents,
  type Account,
  type AuditEvent,
  type AuditFilter,
  type Provider,
  type PublicAccountPayload,
} from "./console-model";
import { LandingPage } from "./landing-page";
import { FeedbackForm } from "./feedback-form";
import { LiveMailExplorer } from "./live-mail-explorer";
import { ProviderLogo } from "./provider-logo";

type View = "inboxes" | "mail" | "assistants" | "approvals" | "activity" | "security" | "feedback";
type InstallationGrant = { accountId: string; permissions: Record<string, boolean> };
type Installation = { id: string; clientName: string | null; revoked: boolean; createdAt: string; lastSeenAt: string | null; grants: InstallationGrant[] };
type ApprovalPreview = { from: string; to: string; cc: string; bcc: string; subject: string; body: { format: string; content: string }; hasAttachments: boolean };
type PendingApproval = { id: string; accountId: string; installationId: string; expiresAt: string; preview: ApprovalPreview };

const names: Record<Provider, string> = { google: "Google", outlook: "Microsoft", imap: "IMAP" };

function Toggle({ checked, onClick, label, disabled = false }: { checked: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? "on" : ""}`} onClick={onClick}><span /></button>;
}

function ProviderIcon({ provider }: { provider: Provider }) {
  return <span className={`provider ${provider}`}>
    {provider === "imap" ? "@" : <ProviderLogo provider={provider}/>}
  </span>;
}

export default function Home() {
  return <Show when="signed-in" fallback={<LandingPage/>}><RelayConsole/></Show>;
}

function RelayConsole() {
  const [view, setView] = useState<View>("inboxes");
  const [highlightApprovalId, setHighlightApprovalId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [connect, setConnect] = useState<0 | 1 | 2>(0);
  const [connectCompose, setConnectCompose] = useState(false);
  const [provider, setProvider] = useState<Provider>("google");
  const [manage, setManage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [mobile, setMobile] = useState(false);
  const [changingAllAccess, setChangingAllAccess] = useState(false);
  const [backend, setBackend] = useState<"checking" | "ready" | "configuration_required" | "unavailable">("checking");
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(null);
  const [manageInstallationId, setManageInstallationId] = useState<string | null>(null);
  const [clientNameDraft, setClientNameDraft] = useState("");
  const [clientManagementStatus, setClientManagementStatus] = useState<"idle" | "renaming" | "removing">("idle");
  const [clientManagementError, setClientManagementError] = useState("");
  const [confirmClientRemoval, setConfirmClientRemoval] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>("all");
  const [auditStatus, setAuditStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const selected = accounts.find(a => a.id === manage);
  const connectedInstallations = installations.filter(installation => !installation.revoked);
  const selectedInstallation = connectedInstallations.find(i => i.id === selectedInstallationId) ?? connectedInstallations[0];
  const managedInstallation = installations.find(i => i.id === manageInstallationId);
  const allAccessPaused = accounts.length > 0 && accounts.every(account => account.paused);
  const pausedAccountCount = accounts.filter(account => account.paused).length;
  const availableAccountCount = accounts.filter(account => !account.paused && account.health === "healthy").length;
  const composeReadyAccountCount = accounts.filter(account => account.permissions.drafts).length;
  const sharedAccountIds = new Set(
    connectedInstallations.flatMap(installation => installation.grants.map(grant => grant.accountId)),
  );
  const activeInstallationCount = installations.filter(installation => !installation.revoked).length;
  const revokedInstallationCount = installations.length - activeInstallationCount;
  const grantedInboxCount = new Set(
    connectedInstallations.flatMap(installation => installation.grants.map(grant => grant.accountId)),
  ).size;
  const blockedEventCount = auditEvents.filter(event => event.decision === "blocked").length;
  const visible = useMemo(() => accounts.filter(a => `${a.label} ${a.address}`.toLowerCase().includes(query.toLowerCase())), [accounts, query]);
  const visibleAuditEvents = useMemo(() => filterAuditEvents(auditEvents, auditFilter), [auditEvents, auditFilter]);

  const flash = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };

  const editInstallationAccess = (installationId: string) => {
    setSelectedInstallationId(installationId);
    window.requestAnimationFrame(() => {
      const accessPanel = document.getElementById("effective-access");
      accessPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      accessPanel?.focus({ preventScroll: true });
    });
  };

  const openClientManagement = (installation: Installation) => {
    setManageInstallationId(installation.id);
    setClientNameDraft(installation.clientName ?? "");
    setClientManagementError("");
    setConfirmClientRemoval(false);
  };

  const [microsoftReady, setMicrosoftReady] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/accounts", { headers: { accept: "application/json" } })
      .then(async response => ({ response, payload: await response.json() as { credential_ready?: boolean; accounts?: PublicAccountPayload[]; microsoft?: { credential_ready?: boolean } } }))
      .then(({ response, payload }) => {
        if (!active) return;
        if (!response.ok) { setAccounts([]); setBackend("unavailable"); return; }
        setMicrosoftReady(Boolean(payload.microsoft?.credential_ready));
        setAccounts(mapPublicAccounts(payload.accounts ?? []));
        if (!payload.credential_ready) { setBackend("configuration_required"); return; }
        setBackend("ready");
      })
      .catch(() => { if (active) { setAccounts([]); setBackend("unavailable"); } });
    const params = new URLSearchParams(window.location.search);
    const googleResult = params.get("relay_google");
    const scopeUpgrade = params.get("relay_google_scope");
    const microsoftResult = params.get("relay_microsoft");
    const microsoftScopeUpgrade = params.get("relay_microsoft_scope");
    const deepLinkedView = params.get("view");
    const deepLinkedApproval = params.get("approval");
    const resultTimer = window.setTimeout(() => {
      if (deepLinkedView === "approvals") {
        setView("approvals");
        setHighlightApprovalId(deepLinkedApproval);
      }
      if (googleResult === "connected" && scopeUpgrade === "compose") setToast("Draft creation enabled for this inbox");
      else if (googleResult === "connected") setToast("Gmail connected with read-only access");
      if (googleResult === "denied") setToast("Google authorization was cancelled");
      if (microsoftResult === "connected" && microsoftScopeUpgrade === "compose") setToast("Draft creation enabled for this inbox");
      else if (microsoftResult === "connected") setToast("Outlook connected with read-only access");
      if (microsoftResult === "denied") setToast("Microsoft authorization was cancelled");
    }, 0);
    return () => { active = false; window.clearTimeout(resultTimer); };
  }, []);

  const refreshInstallations = () => {
    fetch("/api/installations", { headers: { accept: "application/json" } })
      .then(async response => (response.ok ? (await response.json()) as { installations?: Installation[] } : null))
      .then(payload => { if (payload) setInstallations(payload.installations ?? []); })
      .catch(() => {});
  };
  useEffect(() => { refreshInstallations(); }, []);

  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const refreshApprovals = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/approvals", { headers: { accept: "application/json" } });
      if (response.status === 401) return false;
      if (!response.ok) return true;
      const payload = (await response.json()) as { approvals?: PendingApproval[] };
      setApprovals(payload.approvals ?? []);
      return true;
    } catch {
      return true;
    }
  }, []);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      const shouldContinue = await refreshApprovals();
      if (active && shouldContinue) timer = window.setTimeout(poll, 20_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshApprovals]);
  const refreshAudit = useCallback(async () => {
    setAuditStatus("loading");
    try {
      const response = await fetch("/api/audit?limit=100", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("AUDIT_LOAD_FAILED");
      const payload = (await response.json()) as { events?: AuditEvent[] };
      setAuditEvents(payload.events ?? []);
      setAuditStatus("ready");
    } catch {
      setAuditEvents([]);
      setAuditStatus("error");
    }
  }, []);
  useEffect(() => {
    if (view !== "activity" && view !== "security") return;
    const timer = window.setTimeout(() => { void refreshAudit(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshAudit, view]);
  useEffect(() => {
    if (!highlightApprovalId) return;
    document.getElementById(`approval-${highlightApprovalId}`)?.scrollIntoView({ block: "center" });
  }, [highlightApprovalId, approvals]);

  const resolveApproval = async (approvalId: string, decision: "approve" | "deny") => {
    const response = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const payload = response.ok ? (await response.json()) as { state?: string } : null;
    if (!response.ok || !payload) { flash("Could not resolve this approval"); return; }
    if (payload.state === "sent") flash("Sent");
    else if (payload.state === "denied") flash("Send request denied");
    else if (payload.state === "failed") flash("Send failed; nothing was sent");
    else if (payload.state === "delivery_unknown") flash("Delivery unknown -- check the account's Sent folder before trying again");
    else flash("Approval updated");
    refreshApprovals();
  };

  const renameClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!managedInstallation) return;
    const nextName = clientNameDraft.trim();
    if (!nextName) {
      setClientManagementError("Enter a name for this client.");
      return;
    }
    setClientManagementStatus("renaming");
    setClientManagementError("");
    try {
      const response = await fetch(
        `/api/installations/${encodeURIComponent(managedInstallation.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_name: nextName }),
        },
      );
      if (!response.ok) throw new Error("RENAME_FAILED");
      setInstallations(current => current.map(installation =>
        installation.id === managedInstallation.id
          ? { ...installation, clientName: nextName }
          : installation,
      ));
      flash("Client renamed");
    } catch {
      setClientManagementError("Could not rename this client. Please try again.");
    } finally {
      setClientManagementStatus("idle");
    }
  };

  const removeClient = async () => {
    if (!managedInstallation) return;
    setClientManagementStatus("removing");
    setClientManagementError("");
    try {
      const response = await fetch(
        `/api/installations/${encodeURIComponent(managedInstallation.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("REMOVE_FAILED");
      setInstallations(current => current.map(installation =>
        installation.id === managedInstallation.id
          ? { ...installation, revoked: true, grants: [] }
          : installation,
      ));
      if (selectedInstallationId === managedInstallation.id) {
        setSelectedInstallationId(null);
      }
      setManageInstallationId(null);
      setConfirmClientRemoval(false);
      flash("Client removed and inbox permissions cleared");
    } catch {
      setClientManagementError("Could not remove this client. Please try again.");
    } finally {
      setClientManagementStatus("idle");
    }
  };

  const setInstallationGrant = async (installationId: string, accountId: string, backendKey: "search" | "read_body" | "draft" | "send", value: boolean) => {
    const installation = installations.find(i => i.id === installationId);
    const current = installation?.grants.find(g => g.accountId === accountId)?.permissions ?? {};
    const next = { ...current, [backendKey]: value };
    const activePermissions = Object.entries(next).filter(([, granted]) => granted).map(([key]) => key);
    const response = activePermissions.length === 0
      ? await fetch(`/api/installations/${encodeURIComponent(installationId)}/grants/${encodeURIComponent(accountId)}`, { method: "DELETE" })
      : await fetch(`/api/installations/${encodeURIComponent(installationId)}/grants/${encodeURIComponent(accountId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissions: activePermissions }),
        });
    if (!response.ok) { flash("Could not update this client's account access"); return; }
    flash("Client account access updated");
    refreshInstallations();
  };

  const finishConnect = () => {
    if (provider === "imap") { flash("IMAP support is planned after Outlook"); return; }
    const params = new URLSearchParams({ return_to: "/" });
    if (connectCompose) params.set("upgrade", "compose");
    if (provider === "outlook") {
      if (!microsoftReady) { flash("Microsoft credentials must be configured before connecting a real inbox"); return; }
      // A provider OAuth handshake intentionally leaves the Next.js app and requires a full navigation.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/api/oauth/microsoft/start?${params}`);
      return;
    }
    if (backend !== "ready") { flash("Google credentials must be configured before connecting a real inbox"); return; }
    // A provider OAuth handshake intentionally leaves the Next.js app and requires a full navigation.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/api/oauth/google/start?${params}`);
  };

  const setLivePaused = async (account: Account, pausedValue: boolean) => {
    const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: pausedValue }),
    });
    if (!response.ok) { flash("Could not update account access"); return; }
    setAccounts(current => current.map(a => a.id === account.id ? { ...a, paused: pausedValue } : a));
    flash(pausedValue ? "Account access paused" : "Account access resumed");
  };

  const setAllAccountsPaused = async (pausedValue: boolean) => {
    const targets = accounts.filter(account => account.paused !== pausedValue);
    if (targets.length === 0) {
      flash(accounts.length === 0 ? "Connect an inbox before using emergency controls" : pausedValue ? "All inboxes are already paused" : "All inboxes are already active");
      return;
    }
    setChangingAllAccess(true);
    try {
      const results = await Promise.all(targets.map(async account => {
        try {
          const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/pause`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paused: pausedValue }),
          });
          return { id: account.id, ok: response.ok };
        } catch {
          return { id: account.id, ok: false };
        }
      }));
      const changedIds = new Set(results.filter(result => result.ok).map(result => result.id));
      setAccounts(current => current.map(account => changedIds.has(account.id) ? { ...account, paused: pausedValue } : account));
      const failed = results.length - changedIds.size;
      if (failed > 0) flash(`${failed} inbox${failed === 1 ? "" : "es"} could not be updated`);
      else flash(pausedValue ? "All inbox access paused" : "All inbox access resumed");
      void refreshAudit();
    } finally {
      setChangingAllAccess(false);
    }
  };

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/mcp`);
      flash("MCP endpoint copied");
    } catch {
      flash("Could not copy the endpoint");
    }
  };

  const exportAudit = () => {
    if (auditEvents.length === 0) { flash("No audit events to export"); return; }
    const url = URL.createObjectURL(new Blob([serializeAuditEvents(auditEvents)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `relay-audit-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    flash(`${auditEvents.length} audit event${auditEvents.length === 1 ? "" : "s"} exported`);
  };

  const disconnectAccount = async (account: Account) => {
    const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 202) { flash("Disconnect could not be completed"); return; }
    setAccounts(current => current.filter(a => a.id !== account.id));
    setManage(null);
    flash("Inbox disconnected; provider revocation requested");
  };

  const nav: { id: View; label: string; icon: typeof Inbox }[] = [
    { id: "inboxes", label: "Inboxes", icon: Inbox },
    { id: "mail", label: "Mail search", icon: Search },
    { id: "assistants", label: "AI assistants", icon: Bot },
    { id: "approvals", label: "Approvals", icon: MailCheck },
    { id: "activity", label: "Activity log", icon: Activity },
    { id: "security", label: "Security", icon: ShieldCheck },
    { id: "feedback", label: "Feedback", icon: MessageSquareText },
  ];

  return <main className="site-shell">
    <header className="topbar">
      <button className="brand" onClick={() => setView("inboxes")}><span><Mail size={18} /></span><b>INBOXPORT</b><small>MCP ACCESS MANAGER</small></button>
      <div className="top-actions"><UserButton/><button className="menu" onClick={() => setMobile(!mobile)}><Menu size={20} /></button></div>
    </header>

    <div className="layout">
      <aside className={mobile ? "open" : ""}>
        <nav>{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMobile(false); }}><Icon size={17} /><span>{item.label}</span>{item.id === "inboxes" && <b>{accounts.length}</b>}{item.id === "approvals" && approvals.length > 0 && <b>{approvals.length}</b>}</button>; })}</nav>
        <section className={`relay ${allAccessPaused ? "paused" : ""}`}><div><i /><b>{allAccessPaused ? "Mail access paused" : "InboxPort protected"}</b></div><p>{allAccessPaused ? "All connected inboxes reject assistant mail operations." : "Provider credentials are isolated in an encrypted cloud vault."}</p><button disabled={changingAllAccess || accounts.length === 0} onClick={() => setAllAccountsPaused(!allAccessPaused)}>{allAccessPaused ? <Play size={14} /> : <Pause size={14} />}{changingAllAccess ? "Updating inboxes…" : allAccessPaused ? "Resume inbox access" : "Pause inbox access"}</button></section>
      </aside>

      <section className="content">
        <div className="concept-banner"><ShieldCheck size={15}/><span><b>{backend === "checking" ? "Checking InboxPort connections." : accounts.length > 0 ? `${accounts.length} live inbox${accounts.length === 1 ? "" : "es"} connected.` : "No inboxes connected."}</b> {accounts.length > 0 ? "Mailbox, client, approval, and audit data on this screen comes from the InboxPort backend." : backend === "configuration_required" ? "Configure a provider OAuth client, then connect your first mailbox." : backend === "unavailable" ? "Sign in or check the InboxPort backend connection to load your workspace." : "Connect Gmail or Outlook to begin."}</span></div>
        {view === "inboxes" && <>
          <Heading kicker="CONNECTED INBOXES" icon={<Inbox size={14} />} title="Every mailbox, connected in one place." subtitle="Manage Gmail and Outlook connections here. Decide what each AI assistant can use separately." action={<button className="primary" onClick={() => { setConnectCompose(false); setConnect(1); }}><Plus size={17} /> Connect inbox</button>} />

          <section className="inbox-overview" aria-label="Inbox connection summary">
            <div><Inbox/><span><strong>{accounts.length}</strong><b>Connected inboxes</b><small>Gmail and Outlook together</small></span></div>
            <div><ShieldCheck/><span><strong>{availableAccountCount}</strong><b>Available now</b><small>{pausedAccountCount > 0 ? `${pausedAccountCount} paused` : "No inboxes paused"}</small></span></div>
            <div><MessageSquareText/><span><strong>{composeReadyAccountCount}</strong><b>Compose authorized</b><small>Provider OAuth capability</small></span></div>
            <div><Bot/><span><strong>{sharedAccountIds.size}</strong><b>Shared with AI</b><small>At least one assistant grant</small></span></div>
          </section>

          <section className="panel inbox-table-panel">
            <header>
              <div><p className="kicker">MAIL CONNECTIONS</p><h2>Connected inboxes</h2><p>Provider access and assistant sharing are shown separately.</p></div>
              <label><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an inbox" /></label>
            </header>
            <div className="inbox-table-head"><span>Inbox</span><span>Provider capability</span><span>AI assistants</span><span>Status</span><span/></div>
            <div className="inbox-table-body">
              {visible.length === 0 && <div className="inbox-empty">{backend === "checking" ? <RefreshCw className="spin"/> : <Inbox/>}<span><b>{backend === "checking" ? "Loading connected inboxes…" : query ? "No inboxes match your search." : "No inboxes connected."}</b><small>{backend === "checking" ? "Checking the InboxPort backend." : query ? "Try a different name or email address." : "Connect Gmail or Outlook to begin."}</small></span></div>}
              {visible.map(account => {
                const assistantCount = connectedInstallations.filter(installation => installation.grants.some(grant => grant.accountId === account.id)).length;
                const healthLabel = account.paused ? "Paused" : account.health === "healthy" ? "Live" : account.health === "reauthorization_required" ? "Reconnect" : "Retry needed";
                return <article className="inbox-row" key={account.id}>
                  <i className={account.color}/>
                  <div className="inbox-identity"><ProviderIcon provider={account.provider}/><span><b>{account.label}</b><small>{account.address}</small></span></div>
                  <div className="inbox-capabilities"><span><Eye/>Search + read</span><span className={account.permissions.drafts ? "compose" : ""}><MessageSquareText/>{account.permissions.drafts ? "Compose authorized" : "Read only"}</span></div>
                  <div className="inbox-assistant-count"><Bot/><span><b>{assistantCount}</b><small>assistant{assistantCount === 1 ? "" : "s"}</small></span></div>
                  <div className={`inbox-health ${account.health !== "healthy" ? "attention" : ""}`}><i/><span>{healthLabel}</span></div>
                  <button className="inbox-manage" onClick={() => setManage(account.id)}>Manage <ArrowRight/></button>
                </article>;
              })}
            </div>
          </section>

          <section className="inbox-access-layers">
            <header><div><p className="kicker">TWO ACCESS LAYERS</p><h2>Provider capability is not assistant permission.</h2></div><button onClick={() => setView("assistants")}>Manage assistant access <ArrowRight/></button></header>
            <div>
              <article><span><KeyRound/></span><div><small>LAYER 1 · INBOX</small><h3>Provider authorization</h3><p>Google or Microsoft authorizes InboxPort to search, read, and optionally compose for this account.</p></div></article>
              <ArrowRight className="inbox-layer-arrow"/>
              <article><span><SlidersHorizontal/></span><div><small>LAYER 2 · ASSISTANT</small><h3>Per-assistant access</h3><p>Each connected assistant gets independent Search, Read, Draft, and Request Send switches.</p></div></article>
            </div>
          </section>
        </>}

        {view === "mail" && <>
          <Heading kicker="LIVE PROVIDER ACCESS" icon={<Search size={14}/>} title="Search across mailboxes" subtitle="Search and read mail directly from all connected Gmail and Outlook inboxes without building another stored inbox."/>
          <LiveMailExplorer
            accounts={accounts.map(account => ({ id: account.id, address: account.address, paused: account.paused }))}
            onAccountRecovered={accountId => setAccounts(current => current.map(account => account.id === accountId ? { ...account, health: "healthy" } : account))}
          />
        </>}

        {view === "assistants" && <>
          <Heading kicker="ASSISTANT ACCESS" icon={<Bot size={14}/>} title="Connect AI without handing over every inbox." subtitle="Each assistant signs in separately. You choose which inboxes it can search, read, draft from, or request sends for." action={<button className="primary" onClick={copyEndpoint}><Copy size={17}/> Copy MCP endpoint</button>} />
          {allAccessPaused && <div className="pause-banner"><Pause/><span><b>Inbox access is paused.</b> All assistant mail operations return a policy-blocked response.</span><button disabled={changingAllAccess} onClick={() => setAllAccountsPaused(false)}>Resume</button></div>}
          <section className="assistant-overview" aria-label="Assistant access summary">
            <div><Bot/><span><strong>{connectedInstallations.length}</strong><b>Active assistants</b><small>{revokedInstallationCount > 0 ? `${revokedInstallationCount} removed` : "Each signs in separately"}</small></span></div>
            <div><Inbox/><span><strong>{grantedInboxCount}</strong><b>Inboxes shared</b><small>Across every active assistant</small></span></div>
            <div><ShieldCheck/><span><strong>0</strong><b>Default permissions</b><small>New assistants start with no access</small></span></div>
          </section>

          <div className="assistant-workspace">
            <section className="panel assistant-clients-panel">
              <header><div><p className="kicker">CONNECTED CLIENTS</p><h2>Your AI assistants</h2><p>Select Permissions to control inbox access, or Settings to rename and remove a client.</p></div><span className="healthy"><i/>{connectedInstallations.length > 0 ? "access active" : "none connected"}</span></header>
              <div className="assistant-client-list">
                {connectedInstallations.length === 0 && <div className="assistant-empty"><span><Bot/></span><div><b>No assistants connected yet.</b><p>Copy the MCP endpoint, add it to a compatible AI client, and complete its sign-in. It will appear here with zero inbox access.</p></div></div>}
                {connectedInstallations.map(installation => {
                  const clientName = installation.clientName ?? "Unnamed client";
                  const isSelected = installation.id === selectedInstallation?.id;
                  return <article className={`assistant-client-card${isSelected ? " selected" : ""}`} key={installation.id}>
                    <span className="assistant-client-icon"><Bot/></span>
                    <div className="assistant-client-identity"><div><b>{clientName}</b><em><i/> Active</em></div><small>{installation.grants.length} inbox{installation.grants.length === 1 ? "" : "es"} granted</small></div>
                    <div className="assistant-last-seen"><small>LAST CONTACT</small><time>{installation.lastSeenAt ? new Date(installation.lastSeenAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Not yet"}</time></div>
                    <div className="assistant-client-actions">
                      <button type="button" className="client-permissions-action" aria-label={`Edit inbox permissions for ${clientName}`} onClick={() => editInstallationAccess(installation.id)}><SlidersHorizontal/> Permissions</button>
                      <button type="button" className="client-manage-action" aria-label={`Rename or remove ${clientName}`} onClick={() => openClientManagement(installation)}><Settings2/> Settings</button>
                    </div>
                  </article>;
                })}
              </div>
            </section>

            <section className="panel assistant-connect-panel">
              <header><span><PlugZap/></span><div><p className="kicker">CONNECT AN ASSISTANT</p><h2>Use one secure endpoint.</h2></div></header>
              <ol>
                <li><span>1</span><div><b>Copy the endpoint</b><small>Use it as the remote MCP server URL.</small></div></li>
                <li><span>2</span><div><b>Add it to your AI client</b><small>Claude, ChatGPT, or another compatible client.</small></div></li>
                <li><span>3</span><div><b>Sign in and grant inboxes</b><small>New clients receive no mail access by default.</small></div></li>
              </ol>
              <label>MCP endpoint</label>
              <Code value={typeof window === "undefined" ? "/mcp" : `${window.location.origin}/mcp`} onClick={copyEndpoint}/>
              <p className="assistant-connect-note"><LockKeyhole/> No shared API key. Every client gets its own authorization.</p>
            </section>
          </div>

          <section className="panel matrix assistant-access-matrix" id="effective-access" tabIndex={-1}>
            <header className="assistant-access-head">
              <div><p className="kicker">PER-CLIENT POLICY</p><h2>Effective access</h2><p>{selectedInstallation ? `Choose what ${selectedInstallation.clientName ?? "this client"} can do in each inbox.` : "Connect an assistant before granting inbox access."}</p></div>
              {connectedInstallations.length > 0 && <label><span>Editing permissions for</span><select value={selectedInstallation?.id} onChange={event => setSelectedInstallationId(event.target.value)}>{connectedInstallations.map(installation => <option key={installation.id} value={installation.id}>{installation.clientName ?? "Unnamed client"}</option>)}</select></label>}
            </header>
            {selectedInstallation ? accounts.length > 0 ? <>
              <div className="matrix-head"><span>Inbox</span><span>Search</span><span>Read body</span><span>Create draft</span><span>Request send</span></div>
              {accounts.map(account => {
                const grant = selectedInstallation.grants.find(item => item.accountId === account.id)?.permissions ?? {};
                return <div className="matrix-row" key={account.id}>
                  <span><ProviderIcon provider={account.provider}/><span className="assistant-inbox-name"><b>{account.label}</b><small>{account.address}</small></span></span>
                  <span><Toggle checked={Boolean(grant.search)} onClick={() => setInstallationGrant(selectedInstallation.id, account.id, "search", !grant.search)} label={`search for ${account.label}`}/></span>
                  <span><Toggle checked={Boolean(grant.read_body)} onClick={() => setInstallationGrant(selectedInstallation.id, account.id, "read_body", !grant.read_body)} label={`read body for ${account.label}`}/></span>
                  <span title={account.permissions.drafts ? "Allow draft creation" : "Enable compose access in this inbox first"}><Toggle disabled={!account.permissions.drafts} checked={Boolean(grant.draft)} onClick={() => setInstallationGrant(selectedInstallation.id, account.id, "draft", !grant.draft)} label={`draft for ${account.label}`}/></span>
                  <span title={account.permissions.send ? "Allow approval requests" : "Enable compose access in this inbox first"}><Toggle disabled={!account.permissions.send} checked={Boolean(grant.send)} onClick={() => setInstallationGrant(selectedInstallation.id, account.id, "send", !grant.send)} label={`send for ${account.label}`}/></span>
                </div>;
              })}
            </> : <div className="assistant-access-empty"><Inbox/><span><b>No inboxes to grant.</b><small>Connect Gmail or Outlook first.</small></span></div> : <div className="assistant-access-empty"><Bot/><span><b>No assistant selected.</b><small>Connect an assistant using the MCP endpoint above.</small></span></div>}
            <div className="assistant-enforcement"><Fingerprint/><span><b>Removing a client blocks all future InboxPort requests immediately.</b> Its MCP entry may still appear in the assistant&apos;s own settings until you remove it there too. Send access only permits approval requests; every exact message still needs your decision.</span></div>
          </section>
        </>}

        {view === "approvals" && <>
          <Heading kicker="EXACT APPROVED SENDING" icon={<MailCheck size={14}/>} title="Nothing sends without your exact approval." subtitle="Every request shows precisely what will be sent. Approving re-checks the draft one more time immediately before sending." action={<button className="secondary" onClick={refreshApprovals}>Refresh</button>} />
          <section className="approval-summary" aria-label="Approval safety summary">
            <div><strong>{approvals.length}</strong><span>Waiting for you<small>Unreviewed drafts</small></span></div>
            <div><Fingerprint/><span><b>Exact-content check</b><small>The provider draft is verified again before send.</small></span></div>
            <div><ShieldCheck/><span><b>Automatic expiry</b><small>Unresolved requests expire after ten minutes.</small></span></div>
          </section>
          {approvals.length === 0
            ? <section className="panel approval-empty"><span><MailCheck/></span><div><h2>You&apos;re all caught up.</h2><p>When an AI assistant asks to send a draft, the exact message will wait here for your decision. Nothing sends automatically.</p></div></section>
            : <div className="approval-list">{approvals.map(approval => {
              const installation = installations.find(i => i.id === approval.installationId);
              return (
                <article className={`approval-card${approval.id === highlightApprovalId ? " highlighted" : ""}`} id={`approval-${approval.id}`} key={approval.id}>
                  <header>
                    <div className="approval-client"><span><Bot/></span><div><small>REQUESTED BY</small><b>{installation?.clientName ?? "AI assistant"}</b></div></div>
                    <div className="approval-expiry"><i/><span><small>EXPIRES</small><b>{new Date(approval.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</b></span></div>
                  </header>
                  <div className="approval-content">
                    <p className="kicker">MESSAGE TO REVIEW</p>
                    <h2>{approval.preview.subject || "(No subject)"}</h2>
                    <dl>
                      <div><dt>From</dt><dd>{approval.preview.from || approval.accountId}</dd></div>
                      <div><dt>To</dt><dd>{approval.preview.to || "(none)"}</dd></div>
                      {approval.preview.cc && <div><dt>Cc</dt><dd>{approval.preview.cc}</dd></div>}
                      {approval.preview.bcc && <div><dt>Bcc</dt><dd>{approval.preview.bcc}</dd></div>}
                    </dl>
                    <div className="approval-message">{approval.preview.body.content || "(Empty message body)"}</div>
                    {approval.preview.hasAttachments && <div className="approval-warning"><AlertTriangle/><span><b>Attachments are present.</b> InboxPort cannot approve attachment sends yet, so this request will be rejected.</span></div>}
                  </div>
                  <footer>
                    <span><ShieldCheck/><b>Only this exact message</b> can be sent.</span>
                    <div>
                      <button className="approval-deny" onClick={() => resolveApproval(approval.id, "deny")}><X/> Deny</button>
                      <button className="approval-approve" disabled={approval.preview.hasAttachments} onClick={() => resolveApproval(approval.id, "approve")}><Check/> Approve &amp; send</button>
                    </div>
                  </footer>
                </article>
              );
            })}</div>}
        </>}

        {view === "activity" && <>
          <Heading kicker="APPEND-ONLY AUDIT TRAIL" icon={<Activity size={14}/>} title="Nothing happens silently." subtitle="See each request, policy decision, and account touched—without logging mail content." action={<button className="secondary" disabled={auditEvents.length === 0} onClick={exportAudit}>Export JSON</button>}/>
          <section className="panel activity-panel">
            <div className="filters">
              {(["all", "allowed", "blocked", "changed"] as AuditFilter[]).map(filter => <button key={filter} className={auditFilter === filter ? "selected" : ""} onClick={() => setAuditFilter(filter)}>{filter === "all" ? "All events" : `${filter[0].toUpperCase()}${filter.slice(1)}`}</button>)}
              <span>Latest {auditEvents.length} events <button className="icon-button" aria-label="Refresh audit events" disabled={auditStatus === "loading"} onClick={refreshAudit}><RefreshCw className={auditStatus === "loading" ? "spin" : ""}/></button></span>
            </div>
            <div className="timeline">
              {auditStatus === "loading" && auditEvents.length === 0 && <div className="activity-empty"><RefreshCw className="spin"/><span>Loading audit events…</span></div>}
              {auditStatus === "error" && <div className="live-error">The audit log could not be loaded. Sign in or check the InboxPort backend, then try again.</div>}
              {auditStatus === "ready" && visibleAuditEvents.length === 0 && <div className="activity-empty"><Activity/><span>{auditEvents.length === 0 ? "No audit events have been recorded yet." : `No ${auditFilter} events in the latest audit window.`}</span></div>}
              {visibleAuditEvents.map(event => {
                const account = accounts.find(item => item.id === event.accountId);
                const installation = installations.find(item => item.id === event.installationId);
                const presentation = presentAuditEvent(event, account?.label, installation?.clientName ?? undefined);
                return <Event key={event.id} kind={event.decision} title={presentation.title} time={new Date(event.occurredAt).toLocaleString()} text={presentation.text} tags={presentation.tags}/>;
              })}
            </div>
          </section>
        </>}

        {view === "security" && <>
          <Heading kicker="ACCESS CONTROL" icon={<ShieldCheck size={14}/>} title="Security controls." subtitle="See who can reach your inboxes now, then change or stop access from one place." action={<button className="secondary" onClick={() => setView("activity")}><Activity size={16}/> Review activity</button>}/>

          <section className={`security-status-panel ${allAccessPaused ? "paused" : ""}`}>
            <div className="security-state">
              <span>{allAccessPaused ? <Pause/> : <ShieldCheck/>}</span>
              <div>
                <p className="kicker">CURRENT ACCESS</p>
                <h2>{accounts.length === 0 ? "No inboxes connected." : allAccessPaused ? "All inbox access is paused." : pausedAccountCount > 0 ? `${pausedAccountCount} inbox${pausedAccountCount === 1 ? " is" : "es are"} paused.` : "Every connected inbox is available."}</h2>
                <p>{activeInstallationCount === 0 ? "No active assistant can request mail." : `${activeInstallationCount} active assistant${activeInstallationCount === 1 ? " can" : "s can"} use only the account permissions you granted.`}</p>
              </div>
            </div>
            <div className="security-stat-grid">
              <button type="button" onClick={() => setView("inboxes")}><strong>{accounts.length}</strong><span>Connected inboxes<small>{pausedAccountCount} paused</small></span><ArrowRight/></button>
              <button type="button" onClick={() => setView("assistants")}><strong>{activeInstallationCount}</strong><span>Active assistants<small>{revokedInstallationCount} removed</small></span><ArrowRight/></button>
              <button type="button" onClick={() => setView("approvals")}><strong>{approvals.length}</strong><span>Pending approvals<small>need your decision</small></span><ArrowRight/></button>
              <button type="button" onClick={() => setView("activity")}><strong>{auditStatus === "ready" ? blockedEventCount : "—"}</strong><span>Blocked operations<small>latest 100 events</small></span><ArrowRight/></button>
            </div>
          </section>

          <div className="security-control-layout">
            <section className="panel security-inbox-panel">
              <header>
                <div><h2>Inbox access</h2><p>Current provider connection and pause state.</p></div>
                <button type="button" onClick={() => setView("inboxes")}>View all <ArrowRight/></button>
              </header>
              <div className="security-inbox-list">
                {accounts.length === 0 && <div className="security-empty"><Inbox/><span><b>No inboxes connected.</b><small>Connect Gmail or Outlook from the Inboxes tab.</small></span></div>}
                {accounts.map(account => <div className="security-inbox-row" key={account.id}>
                  <ProviderIcon provider={account.provider}/>
                  <span><b>{account.label}</b><small>{account.address}</small></span>
                  <em className={account.paused ? "paused" : "live"}><i/>{account.paused ? "Paused" : "Live"}</em>
                  <button type="button" onClick={() => setManage(account.id)}>Manage</button>
                </div>)}
              </div>
            </section>

            <div className="security-side">
              <section className={`panel security-emergency ${allAccessPaused ? "paused" : ""}`}>
                <p className="kicker"><Unplug/> EMERGENCY CONTROL</p>
                <h2>{allAccessPaused ? "Resume every inbox" : "Pause every inbox"}</h2>
                <p>{allAccessPaused ? "Allow active assistants to use their granted permissions again." : "Block future assistant mail requests across every connected account. Content already received by an assistant cannot be recalled."}</p>
                <button type="button" disabled={changingAllAccess || accounts.length === 0} onClick={() => setAllAccountsPaused(!allAccessPaused)}>{allAccessPaused ? <Play/> : <Pause/>}{changingAllAccess ? "Updating inboxes…" : allAccessPaused ? "Resume inbox access" : "Pause inbox access"}</button>
              </section>

              <section className="panel security-data">
                <header><EyeOff/><div><h2>Data handling</h2><p>What InboxPort retains during normal operation.</p></div></header>
                <div><span>Stored mail corpus</span><b>None</b></div>
                <div><span>Approved-send content</span><b>≤ 10 min</b></div>
                <div><span>Provider credentials shared with AI</span><b>Never</b></div>
              </section>
            </div>
          </div>
        </>}

        {view === "feedback" && <>
          <Heading kicker="FEEDBACK" icon={<MessageSquareText size={14}/>} title="Tell us what needs attention." subtitle="Report a bug, a confusing flow, or anything else. Every message is read."/>
          <FeedbackForm/>
        </>}
      </section>
    </div>

    {connect > 0 && <div className="backdrop" onMouseDown={() => setConnect(0)}>
      <section className="modal" role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <button className="close" onClick={() => setConnect(0)}><X/></button>
        <div className="steps"><span>1</span><i className={connect === 2 ? "done" : ""}/><span className={connect === 2 ? "done" : ""}>2</span></div>
        {connect === 1 ? <>
          <p className="kicker">ADD AN INBOX</p>
          <h2>Choose your mail provider</h2>
          <p className="modal-sub">You&apos;ll sign in directly with your provider. InboxPort never sees your password.</p>
          <div className="providers">{(["google","outlook","imap"] as Provider[]).map(p => {
            const unavailable = p === "imap";
            return <button key={p} disabled={unavailable} className={provider === p ? "selected" : ""} onClick={() => setProvider(p)}>
              <ProviderIcon provider={p}/>
              <span><b>{names[p]}</b><small>{p === "google" ? (backend === "ready" ? "Gmail" : "Gmail · needs OAuth setup") : p === "outlook" ? (microsoftReady ? "Outlook + Microsoft 365" : "Outlook + Microsoft 365 · needs OAuth setup") : "Standards-based mail · coming later"}</small></span>
              {provider === p && !unavailable && <Check/>}
            </button>;
          })}</div>
          <div className="note"><LockKeyhole/> Provider tokens are encrypted per account in InboxPort&apos;s cloud vault and remain revocable.</div>
          <button className="modal-primary" disabled={(provider === "google" && backend !== "ready") || (provider === "outlook" && !microsoftReady) || provider === "imap"} onClick={() => setConnect(2)}>
            {(provider === "google" && backend !== "ready") || (provider === "outlook" && !microsoftReady) ? `${names[provider]} setup required` : <>Continue with {names[provider]} <ArrowRight/></>}
          </button>
        </> : <>
          <p className="kicker">REVIEW ACCESS</p>
          <h2>Start with the minimum</h2>
          <p className="modal-sub">Choose whether to include compose access in the provider consent. Assistant access is still granted separately after connection.</p>
          <div className="permission-review">
            <PermissionRow icon={<Search/>} title="Search messages" text="Live provider search; no retained index" extra={<b className="required">INCLUDED</b>}/>
            <PermissionRow icon={<Eye/>} title="Read message bodies" text="Fetched only for an approved request" extra={<b className="required">INCLUDED</b>}/>
            <PermissionRow icon={<MessageSquareText/>} title="Create drafts" text="Drafts remain with your provider" extra={<Toggle checked={connectCompose} onClick={() => setConnectCompose(value => !value)} label="Create drafts"/>}/>
            <PermissionRow icon={<Send/>} title="Approved sending" text="Every exact payload still requires your approval" extra={<b className={connectCompose ? "required" : "off"}>{connectCompose ? "AVAILABLE" : "OFF"}</b>}/>
          </div>
          <div className="note strong"><Fingerprint/><span><b>Provider credentials stay private.</b> AI clients get scoped, short-lived InboxPort access.</span></div>
          <button className="modal-primary" onClick={finishConnect}><ShieldCheck/> Connect with this access</button>
        </>}
      </section>
    </div>}

    {selected && <div className="backdrop" onMouseDown={() => setManage(null)}>
      <section className="drawer" role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <button className="close" onClick={() => setManage(null)}><X/></button>
        <div className="drawer-account"><ProviderIcon provider={selected.provider}/><div><p className="kicker">INBOX ACCESS</p><h2>{selected.label}</h2><p>{selected.address}</p></div></div>
        <h3>Provider authorization</h3>
        <p className="modal-sub">These capabilities describe what Google or Microsoft has authorized for InboxPort. They do not give every assistant access.</p>
        {selected.health !== "healthy" && <div className="account-health-note"><AlertTriangle/><span><b>{selected.health === "reauthorization_required" ? "Provider sign-in expired." : "The last provider request failed."}</b> {selected.health === "reauthorization_required" ? "Reconnect this inbox to restore access." : "Retry a search. A successful provider request will return it to Live."}</span><button type="button" onClick={() => {
          if (selected.health === "reauthorization_required") {
            // Reauthorization requires a full provider redirect, not a client-side route transition.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.assign(`/api/oauth/${selected.provider === "outlook" ? "microsoft" : "google"}/start?return_to=/`);
          } else {
            setManage(null);
            setView("mail");
          }
        }}>{selected.health === "reauthorization_required" ? "Reconnect" : "Retry search"}</button></div>}
        <div className="drawer-perms">
          <CapabilityRow title="Search message metadata" text="Available to assistants you explicitly grant" status="AUTHORIZED"/>
          <CapabilityRow title="Read message bodies" text="Available to assistants you explicitly grant" status="AUTHORIZED"/>
          <div>
            <span><b>Create drafts</b><small>{selected.permissions.drafts ? "Authorized at the provider; controlled per assistant" : `Requires one-time ${selected.provider === "outlook" ? "Microsoft" : "Google"} compose authorization`}</small></span>
            {selected.permissions.drafts ? <b className="required">AUTHORIZED</b> : <button className="secondary" onClick={() => {
              // Scope upgrades require a full provider redirect, not a client-side route transition.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign(`/api/oauth/${selected.provider === "outlook" ? "microsoft" : "google"}/start?upgrade=compose&return_to=/`);
            }}>Authorize</button>}
          </div>
          <CapabilityRow title="Request approved sends" text={selected.permissions.send ? "Every assistant request still requires exact approval" : "Authorized together with compose access"} status={selected.permissions.send ? "AUTHORIZED" : "OFF"}/>
        </div>
        {selected.permissions.drafts && <div className="provider-capability-note"><KeyRound/><span><b>Why there is no Disable button here</b> OAuth authorization stays on the provider token. Turn Draft and Send off per assistant in Effective Access. To remove the provider authorization itself, disconnect this inbox and reconnect it read-only.</span></div>}
        <button className="secondary account-assistant-access" onClick={() => { setManage(null); setView("assistants"); }}><SlidersHorizontal/> Manage assistant access</button>
        <div className="note strong"><ShieldCheck/> Assistant permissions are checked before every provider request.</div>
        <button className="secondary account-pause" onClick={() => setLivePaused(selected, !selected.paused)}>{selected.paused ? <Play/> : <Pause/>}{selected.paused ? "Resume this inbox" : "Pause this inbox"}</button>
        <button className="modal-primary" onClick={() => setManage(null)}>Done</button>
        <button className="disconnect" onClick={() => disconnectAccount(selected)}><Unplug/> Disconnect inbox</button>
      </section>
    </div>}
    {managedInstallation && <div className="backdrop" onMouseDown={() => clientManagementStatus === "idle" && setManageInstallationId(null)}>
      <section className="modal client-management-modal" role="dialog" aria-modal="true" aria-labelledby="client-management-title" onMouseDown={event => event.stopPropagation()}>
        <button className="close" aria-label="Close client settings" disabled={clientManagementStatus !== "idle"} onClick={() => setManageInstallationId(null)}><X/></button>
        <p className="kicker">CLIENT SETTINGS</p>
        <h2 id="client-management-title">Manage this client</h2>
        <p className="modal-sub">Use a name you will recognize, or remove this client from InboxPort and clear every inbox permission.</p>

        <form className="client-rename-form" onSubmit={renameClient}>
          <label htmlFor="client-display-name">Client name</label>
          <div>
            <input id="client-display-name" name="client_name" maxLength={80} required autoFocus value={clientNameDraft} onChange={event => setClientNameDraft(event.target.value)} />
            <button type="submit" disabled={clientManagementStatus !== "idle" || !clientNameDraft.trim()}>{clientManagementStatus === "renaming" ? "Saving…" : "Save name"}</button>
          </div>
        </form>

        {clientManagementError && <div className="client-management-error" role="alert"><AlertTriangle/>{clientManagementError}</div>}

        <section className={`client-remove-zone ${confirmClientRemoval ? "confirming" : ""}`}>
          <div><b>Remove client</b><p>Immediately block every future InboxPort request and permanently clear its inbox permissions. This does not delete the MCP entry from the assistant&apos;s own settings.</p></div>
          {!confirmClientRemoval ? <button type="button" disabled={clientManagementStatus !== "idle"} onClick={() => setConfirmClientRemoval(true)}><Unplug/> Remove</button> : <div className="client-remove-confirm">
            <span>Remove {managedInstallation.clientName ?? "this client"} and block all future access?</span>
            <button type="button" onClick={() => setConfirmClientRemoval(false)} disabled={clientManagementStatus !== "idle"}>Cancel</button>
            <button type="button" onClick={removeClient} disabled={clientManagementStatus !== "idle"}>{clientManagementStatus === "removing" ? "Removing…" : "Yes, remove"}</button>
          </div>}
        </section>
      </section>
    </div>}
    {toast && <div className="toast"><Check/> {toast}</div>}
  </main>;
}

function Heading({kicker,icon,title,subtitle,action}:{kicker:string;icon:React.ReactNode;title:string;subtitle:string;action?:React.ReactNode}) { return <div className="heading"><div><p className="kicker">{icon}{kicker}</p><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
function Code({value,onClick}:{value:string;onClick:()=>void}) { return <div className="code"><code>{value}</code><button onClick={onClick}><Copy/></button></div>; }
function Event({kind,title,time,text,tags}:{kind:"allowed"|"blocked"|"changed";title:string;time:string;text:string;tags:string[]}) { return <article className="event"><span className={kind}>{kind === "allowed" ? <Check/> : kind === "blocked" ? <X/> : <SlidersHorizontal/>}</span><div><header><h3>{title}</h3><time>{time}</time></header><p>{text}</p><div>{tags.map(t => <small key={t}>{t}</small>)}<small className={`decision ${kind}`}>{kind === "blocked" ? "POLICY BLOCKED" : kind.toUpperCase()}</small></div></div></article>; }
function PermissionRow({icon,title,text,extra}:{icon:React.ReactNode;title:string;text:string;extra:React.ReactNode}) { return <div><span>{icon}<span><b>{title}</b><small>{text}</small></span></span>{extra}</div>; }
function CapabilityRow({title,text,status}:{title:string;text:string;status:"AUTHORIZED"|"OFF"}) { return <div><span><b>{title}</b><small>{text}</small></span><b className={status === "OFF" ? "off" : "required"}>{status}</b></div>; }
