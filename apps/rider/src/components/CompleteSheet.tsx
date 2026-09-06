"use client";

import { useState } from "react";

import { rupees, toMinor, type Assignment, type CompleteBody } from "@/lib/api";

interface Props {
  assignment: Assignment;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: CompleteBody) => void;
}

const FAIL_REASONS = [
  "Nobody at the address",
  "Customer refused the order",
  "Could not find the address",
  "Customer asked to reschedule",
  "Customer did not have the cash",
];

export function CompleteSheet({ assignment, busy, onClose, onSubmit }: Props) {
  const due = assignment.order.collectCashMinor;
  const isCod = due > 0;

  const [outcome, setOutcome] = useState<"DELIVERED" | "FAILED">("DELIVERED");
  // Pre-filled with what is owed, but editable: partial payments are routine
  // and the rider must be able to record what they actually took.
  const [cash, setCash] = useState(isCod ? (due / 100).toFixed(2) : "");
  const [podType, setPodType] = useState<"NONE" | "OTP" | "PHOTO">("NONE");
  const [recipient, setRecipient] = useState("");
  const [reason, setReason] = useState(FAIL_REASONS[0]);
  const [note, setNote] = useState("");

  const collected = toMinor(cash);
  const cashInvalid = isCod && outcome === "DELIVERED" && (collected === null || collected < 0);
  const short = isCod && collected !== null && collected < due;
  const over = isCod && collected !== null && collected > due;

  function submit() {
    if (outcome === "FAILED") {
      onSubmit({ outcome: "FAILED", note: note.trim() ? `${reason} — ${note.trim()}` : reason });
      return;
    }
    onSubmit({
      outcome: "DELIVERED",
      ...(isCod ? { amountCollectedMinor: collected ?? 0 } : {}),
      podType,
      ...(recipient.trim() ? { recipientName: recipient.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  }

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Finish delivery"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="sheet">
        <div className="grab" />
        <h2>Finish {assignment.order.orderNumber}</h2>

        <div className="seg" style={{ margin: "14px 0 4px" }}>
          <button
            type="button"
            aria-pressed={outcome === "DELIVERED"}
            onClick={() => setOutcome("DELIVERED")}
          >
            Delivered
          </button>
          <button
            type="button"
            aria-pressed={outcome === "FAILED"}
            onClick={() => setOutcome("FAILED")}
          >
            Not delivered
          </button>
        </div>

        {outcome === "DELIVERED" ? (
          <>
            {isCod && (
              <>
                <label htmlFor="cash">Cash collected (due {rupees(due)})</label>
                <input
                  id="cash"
                  className="money-input"
                  inputMode="decimal"
                  value={cash}
                  onChange={(e) => setCash(e.target.value)}
                  aria-describedby="cash-help"
                />
                <div id="cash-help">
                  {short && (
                    <div className="alert warn" style={{ marginTop: 10 }}>
                      Short by {rupees(due - (collected ?? 0))}. This is recorded against
                      the order — the shop will follow up.
                    </div>
                  )}
                  {over && (
                    <div className="alert warn" style={{ marginTop: 10 }}>
                      That is more than the amount due. Check before continuing.
                    </div>
                  )}
                </div>
              </>
            )}

            <label>Proof of delivery</label>
            <div className="seg">
              <button type="button" aria-pressed={podType === "NONE"} onClick={() => setPodType("NONE")}>
                None
              </button>
              <button type="button" aria-pressed={podType === "OTP"} onClick={() => setPodType("OTP")}>
                OTP
              </button>
              <button type="button" aria-pressed={podType === "PHOTO"} onClick={() => setPodType("PHOTO")}>
                Photo
              </button>
            </div>

            <label htmlFor="recipient">Who received it? (optional)</label>
            <input
              id="recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Name"
              autoComplete="off"
            />
          </>
        ) : (
          <>
            <label htmlFor="reason">What happened?</label>
            <select id="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {FAIL_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </>
        )}

        <label htmlFor="note">Note (optional)</label>
        <textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the shop should know"
        />

        <div className="stack" style={{ marginTop: 18 }}>
          <button
            type="button"
            className={outcome === "DELIVERED" ? "btn" : "btn warn"}
            disabled={busy || cashInvalid}
            onClick={submit}
          >
            {busy
              ? "Saving…"
              : outcome === "DELIVERED"
                ? isCod
                  ? `Confirm — collected ${collected !== null ? rupees(collected) : "—"}`
                  : "Confirm delivered"
                : "Report not delivered"}
          </button>
          <button type="button" className="btn link" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
