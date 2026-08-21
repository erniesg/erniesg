export type SafeIdDenialCase = readonly [
  label: string,
  value: string,
  expected: false,
];

/** Intentionally fake credential-shaped values used only as denial fixtures. */
export const SAFE_ID_DENIAL_CASES: readonly SafeIdDenialCase[] = [
  ["OpenAI", "sk-proj-FAKEFAKEFAKE", false],
  ["AWS", "AKIAFAKEFAKEFAKE", false],
  ["bearer", "bearer-FAKEFAKEFAKE", false],
  ["JWT", "eyJFAKE.payloadFAKE.signatureFAKE", false],
  ["encoded private key", "BEGIN-RSA-PRIVATE-KEY", false],
  ["Slack", "xoxb-FAKEFAKEFAKE", false],
  ["GitHub", "github_pat_FAKEFAKEFAKE", false],
] as const;
