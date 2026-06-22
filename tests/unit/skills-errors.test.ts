import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

describe('skills store error mapping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('maps fetchSkills rate-limit error by AppError code', async () => {
    rpcMock.mockResolvedValueOnce({ skills: [] });
    hostApiFetchMock.mockRejectedValueOnce(new Error('rate limit exceeded'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().error).toBe('fetchRateLimitError');
  });

  it('maps fetchSkills gateway errors without reporting a rate limit', async () => {
    rpcMock.mockRejectedValueOnce(new Error('Gateway socket is not connected'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().error).toBe('fetchGatewayError');
  });

  it('maps searchSkills timeout error by AppError code', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('request timeout'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('git');

    expect(useSkillsStore.getState().searchError).toBe('searchTimeoutError');
  });

  it('limits marketplace searches to 20 results by default', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: true, results: [] });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('', { category: 'all', sort: 'hot' });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/qoder-skills/search', {
      method: 'POST',
      body: JSON.stringify({ query: '', category: 'all', sort: 'hot', limit: 20 }),
    });
  });

  it('maps installSkill timeout result into installTimeoutError', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'request timeout' });

    const { useSkillsStore } = await import('@/stores/skills');
    await expect(useSkillsStore.getState().installSkill('demo-skill')).rejects.toThrow('installTimeoutError');
  });

  it('keeps newly installed disk skills visible before the prompt snapshot refreshes', async () => {
    rpcMock.mockResolvedValueOnce({ skills: [] });
    hostApiFetchMock
      .mockResolvedValueOnce({
        success: true,
        results: [
          {
            slug: 'market-research-reports',
            version: '1.0.0',
            source: 'qoder-marketplace',
            baseDir: 'C:\\Users\\test\\.openclaw\\skills\\market-research-reports',
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ success: true, results: [] })
      .mockResolvedValueOnce({
        success: true,
        results: [
          {
            name: 'frontend-design',
            baseDir: 'C:\\Users\\test\\.openclaw\\skills\\frontend-design',
          },
        ],
      });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'market-research-reports',
          slug: 'market-research-reports',
          source: 'qoder-marketplace',
        }),
      ]),
    );
  });
});
