export function decibelAuthHeaders(apiKey, origin = 'http://127.0.0.1') {
  const headers = { Origin: String(origin || 'http://127.0.0.1') };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}
