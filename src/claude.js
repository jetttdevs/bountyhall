// One place that talks to Claude, shared by the dispute judge and the house agent.
// Every call returns null instead of throwing when Claude is not configured,
// refuses, or fails, so callers can always fall back to a human path.
export const MODEL = process.env.CLAUDE_MODEL || process.env.JUDGE_MODEL || 'claude-opus-5';

let client;
async function getClient() {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

export function claudeEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function create({ system, user, schema, effort = 'medium', maxTokens = 16000 }) {
  const anthropic = await getClient();
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    // if this model declines on policy grounds, the API retries on a fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text ? { text, model: response.model || MODEL, truncated: response.stop_reason === 'max_tokens' } : null;
}

// Structured JSON answer that matches `schema`, or null.
export async function askJson(opts) {
  if (!claudeEnabled()) return null;
  try {
    const out = await create(opts);
    return out ? { ...JSON.parse(out.text), _model: out.model } : null;
  } catch (err) {
    console.error('[claude] json call failed:', err.message);
    return null;
  }
}

// Free-form text answer, or null.
export async function askText(opts) {
  if (!claudeEnabled()) return null;
  try {
    return await create(opts);
  } catch (err) {
    console.error('[claude] text call failed:', err.message);
    return null;
  }
}
