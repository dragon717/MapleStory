import { uiLocale } from '../../app/i18n';
import type { LoginResponse } from '../../../../shared/protocol';
import type { Appearance, InventoryItem } from '../../../../shared/protocol';
export type { Appearance } from '../../../../shared/protocol';
export interface CharacterSummary { id: string; name: string; level: number; job: number; appearance: Appearance; equipped?: InventoryItem[] }
export interface CharacterList { characters: CharacterSummary[]; slotLimit: number; channelId: number }
const errors: Record<string,string> = { 'invalid session':'登录已过期，请返回首页重新登录。', 'name already exists':'此角色名称已被使用，请换一个名称。', 'invalid character name':'角色名需为2–12个中文字、英文字母或数字，可使用_和-。', 'character slots full':'角色栏位已满。', 'character not found':'找不到此角色，请返回频道重试。', 'channel unavailable':'目前仅开放主频道 CH. 1。', 'appearance option unavailable':'此外观暂不可用，请重新选择。', 'request conflict':'创建内容已变化，请返回角色选择后重试。', 'account persistence failed':'角色保存失败，请稍后重试。' };
export async function lobbyRequest<T>(session: LoginResponse, action: string, fields: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/lobby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session.token, action, ...fields }) });
  const body = await response.json();
  if (!response.ok) throw new Error((uiLocale() !== 'en' && errors[body.error]) || body.error || `请求失败 (${response.status})`);
  return body;
}
