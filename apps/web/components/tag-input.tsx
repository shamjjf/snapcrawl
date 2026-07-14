"use client";

// Tag-style editor for list-type config fields (FR-AP-021): allowed domains,
// selectors, URL patterns, blocklist words, mask selectors. Enter or comma adds
// an entry; Backspace on an empty field removes the last; each entry can be
// validated before it's accepted.

import { useState, type KeyboardEvent } from "react";

export function TagInput({
  id,
  values,
  onChange,
  placeholder,
  validate,
  ariaLabel,
}: {
  id?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Return an error message to reject an entry, or null to accept. */
  validate?: (value: string) => string | null;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add(raw: string) {
    const value = raw.trim().replace(/,$/, "").trim();
    if (!value) return;
    if (values.includes(value)) {
      setError(`"${value}" is already in the list.`);
      return;
    }
    const problem = validate?.(value) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    onChange([...values, value]);
    setDraft("");
    setError(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div>
      <div className="tag-input">
        {values.map((v) => (
          <span className="tag" key={v}>
            {v}
            <button
              type="button"
              className="tag__remove"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="tag-input__field"
          value={draft}
          aria-label={ariaLabel}
          placeholder={values.length ? "" : placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
        />
      </div>
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
