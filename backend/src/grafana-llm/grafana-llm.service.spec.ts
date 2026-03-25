import { GrafanaLlmService } from './grafana-llm.service';

describe('GrafanaLlmService', () => {
  const originalToken = process.env.GRAFANA_SA_TOKEN;
  const originalBaseUrl = process.env.GRAFANA_LLM_BASE_URL;
  const originalModel = process.env.GRAFANA_LLM_MODEL;

  beforeEach(() => {
    process.env.GRAFANA_SA_TOKEN = 'glsa-test';
    process.env.GRAFANA_LLM_BASE_URL = 'https://example.test/openai/v1';
    process.env.GRAFANA_LLM_MODEL = 'gpt-4o';
  });

  afterAll(() => {
    if (originalToken) {
      process.env.GRAFANA_SA_TOKEN = originalToken;
    } else {
      delete process.env.GRAFANA_SA_TOKEN;
    }

    if (originalBaseUrl) {
      process.env.GRAFANA_LLM_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.GRAFANA_LLM_BASE_URL;
    }

    if (originalModel) {
      process.env.GRAFANA_LLM_MODEL = originalModel;
    } else {
      delete process.env.GRAFANA_LLM_MODEL;
    }
  });

  it('enters cooldown after a 429 response and skips repeated requests while cooling down', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error(
            "error, status code: 429, status: 429 Too Many Requests, message: invalid character 'I' looking for beginning of value, body: Instance weekly rate limit exceeded (0.002563 requests per sec; 1550 max limit per week)",
          ),
          { status: 429 },
        ),
      );
    const service = new GrafanaLlmService();

    (service as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create,
        },
      },
    };

    await expect(
      service.createChatCompletion({
        systemPrompt: 'system',
        userPrompt: 'user',
      }),
    ).resolves.toBeNull();

    const cooldownMs = service.getCooldownRemainingMs();
    expect(cooldownMs).toBeGreaterThanOrEqual(7 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(10 * 60 * 1000);

    await expect(
      service.createChatCompletion({
        systemPrompt: 'system',
        userPrompt: 'user',
      }),
    ).resolves.toBeNull();

    expect(create).toHaveBeenCalledTimes(1);
  });
});
