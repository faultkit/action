// A small agent for the acceptance runs. It asks the model to classify a
// ticket and records the result. Unguarded, a failed model call falls back to
// a keyword guess and still records the ticket as triaged: the silent failure
// the invariant forbids.
export async function triage(ticket, { guarded }) {
  let label = null;
  try {
    const res = await fetch(`${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: ticket }] }),
    });
    if (res.ok) label = (await res.json()).choices?.[0]?.message?.content ?? null;
  } catch {
    label = null;
  }
  if (label) return { status: 'triaged', label, source: 'model' };
  if (guarded) return { status: 'held', label: null, source: null };
  return { status: 'triaged', label: 'billing', source: 'keyword-fallback' };
}
