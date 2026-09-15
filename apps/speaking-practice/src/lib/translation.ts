export const TRANSLATION_API_URL_STORAGE_KEY = 'speaking-practice:translation-api-url';
export const TRANSLATION_API_KEY_STORAGE_KEY = 'speaking-practice:translation-api-key';
export const TRANSLATION_MODEL_STORAGE_KEY = 'speaking-practice:translation-model';

export type TranslationConfig = { apiUrl: string; apiKey: string; model: string };
export type TranslationStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type TranslationCue = { id: string; text: string };
export type TranslationMap = Record<string, string>;

export function readTranslationConfig(storage: TranslationStorage | null | undefined): TranslationConfig {
  return {
    apiUrl: storage?.getItem(TRANSLATION_API_URL_STORAGE_KEY)?.trim() ?? '',
    apiKey: storage?.getItem(TRANSLATION_API_KEY_STORAGE_KEY)?.trim() ?? '',
    model: storage?.getItem(TRANSLATION_MODEL_STORAGE_KEY)?.trim() ?? '',
  };
}

export function saveTranslationConfig(storage: TranslationStorage, config: TranslationConfig): void {
  storage.setItem(TRANSLATION_API_URL_STORAGE_KEY, config.apiUrl.trim());
  storage.setItem(TRANSLATION_API_KEY_STORAGE_KEY, config.apiKey.trim());
  storage.setItem(TRANSLATION_MODEL_STORAGE_KEY, config.model.trim());
}

export function isTranslationConfigComplete(config: TranslationConfig): boolean {
  return Boolean(config.apiUrl && config.apiKey && config.model);
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

export function parseTranslationResponse(content: string, expectedIds: string[]): TranslationMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    throw new Error('中文翻译返回格式无法识别');
  }

  const rawTranslations = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { translations?: unknown }).translations)
      ? (parsed as { translations: unknown[] }).translations
      : [];
  const result: TranslationMap = {};
  rawTranslations.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const id = String((item as { id?: unknown }).id ?? '');
    const text = String((item as { text?: unknown }).text ?? '').trim();
    if (id && text) result[id] = text;
  });

  if (expectedIds.some((id) => !result[id])) throw new Error('中文翻译返回不完整');
  return result;
}

export async function translateCues(
  cues: TranslationCue[],
  config: TranslationConfig,
  fetcher: typeof fetch = fetch,
): Promise<TranslationMap> {
  if (!isTranslationConfigComplete(config)) throw new Error('请先填写翻译接口地址、API Key 和模型名称');
  if (!cues.length) return {};

  const response = await fetcher(config.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: '你是英语学习字幕翻译助手。将每条英文字幕翻译成自然、简洁的简体中文。必须保留每个 id，并严格返回 JSON：{"translations":[{"id":"0","text":"中文"}]}。不要添加解释。',
        },
        { role: 'user', content: JSON.stringify(cues) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    let message = `翻译接口请求失败（${response.status}）`;
    try {
      const errorBody = await response.json() as { error?: { message?: string } };
      if (errorBody.error?.message) message = errorBody.error.message;
    } catch {
      // Keep the status-based error when the response is not JSON.
    }
    throw new Error(message);
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('翻译接口没有返回翻译内容');
  return parseTranslationResponse(content, cues.map((cue) => cue.id));
}
