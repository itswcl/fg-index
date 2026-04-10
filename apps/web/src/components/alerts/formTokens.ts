/**
 * Shared visual tokens for AlertForm and WebhookForm.
 * Change values here to update both forms consistently.
 */

export const FORM_TOKENS = {
  /** Primary text inside inputs */
  inputFontSize: 13,
  /** Padding inside text inputs */
  inputPadding: '7px 10px',
  /** Border radius for inputs and action buttons */
  inputBorderRadius: 8,

  /** Section label (NAME, CONDITIONS, PLATFORM, …) */
  labelFontSize: 10,
  labelFontWeight: 700,
  labelLetterSpacing: 1,

  /** Primary / secondary action buttons (Create, Cancel, Save, Test, Remove) */
  actionBtnFontSize: 12,
  actionBtnPaddingPrimary: '6px 16px',
  actionBtnPaddingSecondary: '6px 14px',
  actionBtnBorderRadius: 8,
} as const;
