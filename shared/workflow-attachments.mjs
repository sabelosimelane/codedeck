export const ATTACHMENT_MAX_COUNT = 20;
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_NAME_MAX_BYTES = 255;

export function isSafeAttachmentName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !/[\p{Cc}\p{Cf}\p{Cs}/\\]/u.test(name)
    && new TextEncoder().encode(name).length <= ATTACHMENT_NAME_MAX_BYTES;
}
