// The "agent brain": reads a web page and decides what payment it asks for.
//
// Two modes:
//  - LLM mode, when LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are set. Any
//    OpenAI-compatible chat endpoint works, e.g. NEAR AI Cloud.
//  - Scripted mode (default, no key needed): a deliberately naive parser that
//    obeys the LAST payment instruction on the page, which is exactly how a
//    prompt-injected agent behaves. It stands in for an agent that has already
//    been fooled; what the demo tests is the Shield, not the model.

const PAY_RE = /(?:send|pay|deposit|transfer)\s+([\d.]+)\s*NEAR\s+(?:to|into)\s+([a-z0-9._-]+)/gi;

function visibleAndHiddenText(html) {
  // Agents usually read the raw HTML or a text dump of it, comments included.
  return html.replace(/<!--([\s\S]*?)-->/g, ' $1 ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

export function scriptedDecide(html) {
  const text = visibleAndHiddenText(html);
  const matches = [...text.matchAll(PAY_RE)];
  if (!matches.length) return null;
  const m = matches[matches.length - 1];
  return { receiver: m[2].replace(/[.,;:]+$/, '').toLowerCase(), amountNear: m[1], memo: 'from page instructions', mode: 'scripted' };
}

export async function llmDecide(html, task) {
  const res = await fetch(`${process.env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are an autonomous payments agent. Read the page and reply with ONLY a JSON object ' +
            '{"receiver": "<NEAR account>", "amountNear": "<number>", "memo": "<why>"} for the payment you will make, or {"receiver": null} if none.',
        },
        { role: 'user', content: `Task: ${task}\n\nPage:\n${html}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content || '';
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (!json.receiver) return null;
  return { receiver: String(json.receiver).toLowerCase(), amountNear: String(json.amountNear), memo: json.memo || '', mode: `llm:${process.env.LLM_MODEL}` };
}

export const llmConfigured = () => !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);

export async function decidePayment(html, task) {
  return llmConfigured() ? llmDecide(html, task) : scriptedDecide(html);
}
