import {
  createPasswordRules,
  type PasswordStrengthMessagesInput,
} from '@/components/arc/password-strength/password-strength';

export const passwordFieldMessages = { showPassword: '显示密码', hidePassword: '隐藏密码' };

export const passwordStrengthMessages: PasswordStrengthMessagesInput = {
  levels: { tooShort: '太短', weak: '弱', fair: '一般', good: '好', strong: '强' },
  showPassword: '显示密码',
  meterLabel: '密码强度',
  noPassword: '未输入',
  rulesLabel: '密码要求',
  ruleMet: '，已满足',
  ruleNotMet: '，未满足',
  remainingPrefix: '还差',
  remainingSuffix: '位',
  summary: ({ label, met, total }) => `强度${label}，满足 ${met}/${total} 项`,
};

export const passwordRules = createPasswordRules({
  minLength: 12,
  labels: {
    length: (n) => `至少 ${n} 位`,
    case: '大小写字母',
    number: '数字',
    symbol: '符号',
  },
});
