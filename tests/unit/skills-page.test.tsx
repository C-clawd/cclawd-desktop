import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Skills } from '@/pages/Skills/index';

const fetchSkillsMock = vi.fn();
const searchSkillsMock = vi.fn();
const installSkillMock = vi.fn();
const uninstallSkillMock = vi.fn();
const enableSkillMock = vi.fn();
const disableSkillMock = vi.fn();
const invokeIpcMock = vi.fn();
const hostApiFetchMock = vi.fn();

const { gatewayState, skillsState } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789 },
  },
  skillsState: {
    skills: [] as Array<Record<string, unknown>>,
    builtinSkills: [] as Array<Record<string, unknown>>,
    loading: false,
    error: null as string | null,
    searchResults: [] as Array<Record<string, unknown>>,
    searching: false,
    searchError: null as string | null,
    installing: {} as Record<string, boolean>,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: () => ({
    ...skillsState,
    fetchSkills: fetchSkillsMock,
    searchSkills: searchSkillsMock,
    installSkill: installSkillMock,
    uninstallSkill: uninstallSkillMock,
    enableSkill: enableSkillMock,
    disableSkill: disableSkillMock,
  }),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Skills page gateway errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayState.status = { state: 'running', port: 18789 };
    skillsState.skills = [];
    skillsState.builtinSkills = [];
    skillsState.loading = false;
    skillsState.error = null;
    skillsState.searchResults = [];
    skillsState.searching = false;
    skillsState.searchError = null;
    skillsState.installing = {};
    fetchSkillsMock.mockResolvedValue(undefined);
    searchSkillsMock.mockResolvedValue(undefined);
    invokeIpcMock.mockResolvedValue('C:\\Users\\test\\.openclaw\\skills');
  });

  it('does not show stale rate-limit errors while the gateway is stopped', () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.error = 'rateLimitError';

    render(<Skills />);

    expect(screen.getByText('gatewayWarning')).toBeInTheDocument();
    expect(screen.queryByText('rateLimitError')).not.toBeInTheDocument();
  });
});
