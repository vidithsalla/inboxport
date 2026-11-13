"use client";

import { AlertTriangle, CheckCircle2, Send } from "lucide-react";
import { type FormEvent, useState } from "react";

type SubmissionState = "idle" | "sending" | "sent" | "error";

export function FeedbackForm() {
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState("");
  const [status, setStatus] = useState<SubmissionState>("idle");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("sending");
    setError("");

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, feedback }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;

      if (!response.ok) {
        const message =
          payload?.error === "FEEDBACK_NOT_CONFIGURED"
            ? "Feedback delivery is not connected yet. Please try again later."
            : payload?.error === "FEEDBACK_INVALID"
              ? "Write at least 3 characters of feedback. If you include an email, make sure it is valid."
              : "Your feedback could not be sent. Please try again.";
        throw new Error(message);
      }

      setEmail("");
      setFeedback("");
      setStatus("sent");
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Your feedback could not be sent. Please try again.",
      );
      setStatus("error");
    }
  };

  return (
    <section className="panel feedback-panel">
      <form className="feedback-form" onSubmit={submit}>
        <label htmlFor="feedback-email">
          <span>Email <small>(optional)</small></span>
          <input
            id="feedback-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={320}
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <small>Leave this blank to submit anonymously, or add it if you want a reply.</small>
        </label>

        <label htmlFor="feedback-message">
          <span>Feedback</span>
          <textarea
            id="feedback-message"
            name="feedback"
            minLength={3}
            maxLength={5000}
            placeholder="Tell us what happened, what felt confusing, or what you would like InboxPort to do."
            required
            rows={9}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <small>{feedback.length.toLocaleString()} / 5,000</small>
        </label>

        {status === "sent" && (
          <div className="feedback-status success" role="status">
            <CheckCircle2 />
            <span><b>Feedback sent.</b> Thanks for helping improve InboxPort.</span>
          </div>
        )}
        {status === "error" && (
          <div className="feedback-status error" role="alert">
            <AlertTriangle />
            <span>{error}</span>
          </div>
        )}

        <button className="primary feedback-submit" type="submit" disabled={status === "sending"}>
          {status === "sending" ? <><span className="feedback-spinner" /> Sending…</> : <><Send /> Submit feedback</>}
        </button>
      </form>
    </section>
  );
}
