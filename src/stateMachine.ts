import { ConsultationState } from './types';

interface TransitionRule {
  from: ConsultationState;
  to: ConsultationState[];
}

const TRANSITIONS: TransitionRule[] = [
  { from: 'Borrador', to: ['Admision'] },
  { from: 'Admision', to: ['Consentimiento', 'Borrador'] },
  { from: 'Consentimiento', to: ['Tratamiento', 'Admision'] },
  { from: 'Tratamiento', to: ['Evaluacion', 'Consentimiento'] },
  { from: 'Evaluacion', to: [] } // El estado final queda cerrado de forma segura para resguardo legal
];

export function validateStateTransition(current: ConsultationState, next: ConsultationState): boolean {
  const rule = TRANSITIONS.find(t => t.from === current);
  if (!rule) return false;
  return rule.to.includes(next);
}
