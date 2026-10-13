/**
 * Defence in depth against stored XSS. React already escapes text when rendering, but the API may be
 * consumed by other clients, so free-text fields are stored as plain text: HTML tags are stripped and
 * control characters removed. Rendering never uses dangerouslySetInnerHTML.
 */
export function plainText(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}
