"use client";

import { SignInButton } from "@clerk/nextjs";
import Image from "next/image";
import {
  ArrowRight,
  Bot,
  Check,
  EyeOff,
  Fingerprint,
  Inbox,
  LockKeyhole,
  Mail,
  MailCheck,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ProviderLogo } from "./provider-logo";

const safeguards = [
  {
    icon: <Fingerprint />,
    number: "01",
    title: "Connect every account in one place",
    text: "Add all the Gmail and Outlook accounts you use. Each stays isolated and separately revocable.",
  },
  {
    icon: <EyeOff />,
    number: "02",
    title: "Grant the smallest useful access",
    text: "Choose which assistant can search, read, draft, or request a send for each individual inbox.",
  },
  {
    icon: <MailCheck />,
    number: "03",
    title: "Approve the exact message",
    text: "Sending requires a short-lived approval tied to the precise recipients, subject, and body.",
  },
];

const connectedInboxes = [
  { provider: "google", label: "Personal Gmail", address: "you@gmail.com" },
  { provider: "google", label: "Projects Gmail", address: "projects@gmail.com" },
  { provider: "google", label: "Family Gmail", address: "family@gmail.com" },
  { provider: "outlook", label: "Work Outlook", address: "you@company.com" },
] satisfies Array<{ provider: "google" | "outlook"; label: string; address: string }>;

function AssistantLogoStack() {
  return (
    <span className="landing-assistant-stack" aria-label="Claude and ChatGPT">
      <span><Image alt="Claude" height={27} src="/brands/claude.svg" width={27}/></span>
      <span><Image alt="ChatGPT" height={24} src="/brands/chatgpt.svg" width={24}/></span>
    </span>
  );
}

export function LandingPage() {
  return (
    <main className="landing">
      <header className="landing-nav">
        <a className="landing-brand" href="#top" aria-label="InboxPort home">
          <span><Mail size={18}/></span>
          <b>INBOXPORT</b>
          <small>MCP ACCESS MANAGER</small>
        </a>
        <nav aria-label="Landing page navigation">
          <a href="#security">Security</a>
          <a href="#how-it-works">How it works</a>
          <a href="#architecture">Architecture</a>
        </nav>
        <div className="landing-nav-actions">
          <SignInButton mode="modal">
            <button className="landing-signin" type="button">Sign in</button>
          </SignInButton>
          <SignInButton mode="modal">
            <button className="landing-nav-cta" type="button">Open InboxPort <ArrowRight/></button>
          </SignInButton>
        </div>
      </header>

      <section className="landing-hero" id="top">
        <div className="landing-hero-copy">
          <p className="landing-kicker"><ShieldCheck/> ONE MCP ACCESS MANAGER. EVERY INBOX.</p>
          <h1>Connect <em>every Gmail and Outlook account</em> to your AI.</h1>
          <p className="landing-lede">
            Connect all your Gmail and Outlook accounts, not just one of each.
            Let your AI search, read, and draft across personal and work email
            while you control access account by account.
          </p>
          <p className="landing-product-definition">
            <LockKeyhole/>
            <span>An MCP access manager for your existing inboxes—not another email app.</span>
          </p>
          <div className="landing-hero-actions">
            <SignInButton mode="modal">
              <button className="landing-hero-cta" type="button">Connect your inboxes <ArrowRight/></button>
            </SignInButton>
            <a href="#security">See the security model</a>
          </div>
          <div className="landing-trust-line">
            <span><Check/> Multiple Gmail accounts</span>
            <span><Check/> Gmail and Outlook together</span>
            <span><Check/> Separate permissions for every inbox</span>
          </div>
        </div>

        <div className="landing-console" aria-label="InboxPort multiple-account MCP access manager preview">
          <div className="landing-console-head">
            <span><Mail/> 4 CONNECTED INBOXES</span>
            <b><i/> ONE INBOXPORT MCP GATEWAY</b>
          </div>
          <div className="landing-request">
            <div className="landing-request-icon"><Sparkles/></div>
            <div>
              <small>AI CLIENT</small>
              <strong>Your assistant</strong>
            </div>
            <ArrowRight/>
            <div>
              <small>CONTROLLED ACCESS</small>
              <strong>Personal + work mail</strong>
            </div>
          </div>
          <div className="landing-permissions">
            {connectedInboxes.map(inbox => <div key={inbox.address}>
              <span>
                <i className="landing-account-mark"><ProviderLogo provider={inbox.provider} size={24}/></i>
                <span className="landing-inbox-copy">
                  <b>{inbox.label}</b>
                  <small>{inbox.address}</small>
                </span>
              </span>
              <small className="allowed">CONNECTED</small>
            </div>)}
          </div>
          <div className="landing-decision">
            <ShieldCheck/>
            <span><small>ACCESS MODEL</small><b>Controlled account by account</b></span>
            <strong>4 / 4</strong>
          </div>
        </div>
      </section>

      <section className="landing-security" id="security">
        <div className="landing-security-copy">
          <p className="landing-kicker"><EyeOff/> A SECURE RELAY, NOT ANOTHER MAILBOX</p>
          <h2>InboxPort does not retain a copy of your inbox.</h2>
          <p>
            InboxPort fetches mail from Gmail or Outlook only when you or an
            authorized assistant asks for it. It does not build a mailbox
            corpus or search index. For an approved send, the exact message is
            encrypted and retained for no more than ten minutes while you
            confirm it.
          </p>
          <ul>
            <li><Check/><span><b>Credentials isolated per account</b><small>Encrypted provider tokens remain revocable.</small></span></li>
            <li><Check/><span><b>Access checked on every request</b><small>Pause, revoke, and policy changes take effect immediately.</small></span></li>
            <li><Check/><span><b>Audit without copying message content</b><small>Review operations, decisions, and accounts touched.</small></span></li>
          </ul>
        </div>
        <div className="landing-security-card">
          <div><small>RETAINED MAIL CORPUS</small><strong>0</strong></div>
          <div><small>APPROVED-SEND ENVELOPE</small><strong>≤ 10 min</strong></div>
          <div><small>PROVIDER CREDENTIALS SHARED WITH AI</small><strong>Never</strong></div>
          <p><ShieldCheck/> CONTENT-MINIMIZED BY DEFAULT</p>
        </div>
      </section>

      <section className="landing-provider-strip" aria-label="Supported connections">
        <p>ONE CONTROL PLANE FOR</p>
        <div><b className="landing-provider-mark"><ProviderLogo provider="google" size={24}/></b> Gmail</div>
        <div><b className="landing-provider-mark"><ProviderLogo provider="outlook" size={24}/></b> Outlook</div>
        <div><AssistantLogoStack/> AI assistants</div>
        <div><LockKeyhole/> Remote MCP</div>
      </section>

      <section className="landing-steps" id="how-it-works">
        <div className="landing-section-heading">
          <p className="landing-kicker"><Fingerprint/> CONTROL WITHOUT FRICTION</p>
          <h2>
            <span>Connect every inbox once.</span>
            <span>Control every AI action after.</span>
          </h2>
          <p>InboxPort checks what an assistant is allowed to do before the request ever reaches your mail provider.</p>
        </div>
        <div className="landing-step-grid">
          {safeguards.map(safeguard => <article key={safeguard.number}>
            <header><span>{safeguard.icon}</span><small>{safeguard.number}</small></header>
            <h3>{safeguard.title}</h3>
            <p>{safeguard.text}</p>
          </article>)}
        </div>
      </section>

      <section className="landing-architecture" id="architecture">
        <p className="landing-kicker"><LockKeyhole/> THE CONTROLLED ROUTE</p>
        <h2>The AI never connects directly to Gmail or Outlook.</h2>
        <div className="landing-route">
          <span><Bot/><b>AI client</b><small>Scoped InboxPort identity</small></span>
          <i><ArrowRight/></i>
          <span className="active"><ShieldCheck/><b>InboxPort MCP access manager</b><small>Authorize, audit, decrypt</small></span>
          <i><ArrowRight/></i>
          <span><Inbox/><b>Mail provider</b><small>Only approved operations</small></span>
        </div>
      </section>

      <section className="landing-final">
        <div>
          <p className="landing-kicker"><Sparkles/> READY WHEN YOUR ASSISTANT IS</p>
          <h2>Give AI the email access it needs, and nothing more.</h2>
        </div>
        <SignInButton mode="modal">
          <button className="landing-hero-cta" type="button">Connect your inboxes <ArrowRight/></button>
        </SignInButton>
      </section>

      <footer className="landing-footer">
        <a className="landing-brand" href="#top"><span><Mail size={16}/></span><b>INBOXPORT</b></a>
        <p>The MCP access manager for every Gmail and Outlook account.</p>
        <small>SECURITY-FIRST BY DESIGN</small>
      </footer>
    </main>
  );
}
