import type { Actor, RoleKey } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import { canChangeMeeting, meetingIsOpen } from './access.js';

const actor = (role: RoleKey, employeeId: string): Actor => ({
  employeeId,
  role,
  sector: role === 'diretoria' ? 'diretoria' : 'comercial',
  isSectorManager: false,
});
const deal = { ownerEmployeeId: 'owner-1' };

describe('canChangeMeeting', () => {
  it('lets the deal owner change it', () => {
    expect(canChangeMeeting(actor('vendedor_formatacao', 'owner-1'), deal)).toBe(true);
  });

  it('keeps another seller out, and a deal nobody owns out of a seller’s reach', () => {
    expect(canChangeMeeting(actor('vendedor_formatacao', 'other'), deal)).toBe(false);
    expect(canChangeMeeting(actor('vendedor_formatacao', 'other'), { ownerEmployeeId: null })).toBe(
      false,
    );
  });

  it('lets the roles that write on every deal change any', () => {
    expect(canChangeMeeting(actor('admin_master', 'boss'), deal)).toBe(true);
    expect(canChangeMeeting(actor('gerente_comercial', 'boss'), deal)).toBe(true);
  });

  it('refuses a role without leads.write even when it owns the deal or reads every deal', () => {
    // Diretoria reads every deal and writes none; being the owner on paper does not change that.
    expect(canChangeMeeting(actor('diretoria', 'boss'), deal)).toBe(false);
    expect(canChangeMeeting(actor('diretoria', 'owner-1'), deal)).toBe(false);
  });
});

describe('meetingIsOpen', () => {
  it('is true only before the meeting is held or cancelled', () => {
    expect(meetingIsOpen('agendada')).toBe(true);
    expect(meetingIsOpen('em_andamento')).toBe(true);
    expect(meetingIsOpen('encerrada')).toBe(false);
    expect(meetingIsOpen('cancelada')).toBe(false);
  });
});
