import type { BrowserWindow } from 'electron';
import type { GatewayManager } from '../gateway/manager';
import type { ClawHubService } from '../gateway/clawhub';
import type { QoderSkillService } from '../gateway/qoder-skills';
import type { HostEventBus } from './event-bus';

export interface HostApiContext {
  gatewayManager: GatewayManager;
  clawHubService: ClawHubService;
  qoderSkillService: QoderSkillService;
  eventBus: HostEventBus;
  mainWindow: BrowserWindow | null;
}
