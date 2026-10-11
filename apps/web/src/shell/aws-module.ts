import type { ModuleManifest } from './module-contract';
import icon from '../assets/aws.svg';
export const awsModule = { id: 'aws', name: 'AWS', icon, mobile: false,
  focus: { ko: '조직별 계정 상태 · 접근 · 점검 근거', en: 'Organization account state, access and inspection evidence' },
} as const satisfies ModuleManifest;
