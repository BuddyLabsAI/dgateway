// Storing a provider key by pasting it needs GATEWAY_SECRET on the gateway. The health report says
// whether that is set (never its value), so a screen can warn before a key is pasted and offer the
// environment-variable route up front. A refused paste carries a code that names the same condition,
// so the console matches the code, never the message. Pure.

/** The code the gateway sends when it refuses to store a key because GATEWAY_SECRET is unset. */
export const SECRET_MISSING_CODE = "gateway_secret_missing";

/** True when a gateway refusal is the missing-secret refusal, by its code. */
export function isSecretMissing(code: string | null | undefined): boolean {
  return code === SECRET_MISSING_CODE;
}

export interface PasteAdvice {
  /** What to say before the paste field, or null when a paste should work. */
  warning: { title: string; body: string } | null;
  /** Start on the environment-variable route rather than on the paste field. */
  envFirst: boolean;
}

/**
 * The advice for storing a key by pasting it, from the health report's secret_configured. Only a
 * gateway that says the secret is unset is warned. A gateway that reports nothing (it predates the
 * field) gets no warning, and a refused paste still explains itself.
 */
export function pasteAdvice(secretConfigured: boolean | null | undefined): PasteAdvice {
  if (secretConfigured !== false) return { warning: null, envFirst: false };
  return {
    warning: {
      title: "This gateway can't store keys yet",
      body: "Stored keys are encrypted with GATEWAY_SECRET, and the gateway was started without it. Keep the key in an environment variable instead, or set GATEWAY_SECRET to a long random value, restart the gateway, and then paste the key.",
    },
    envFirst: true,
  };
}
