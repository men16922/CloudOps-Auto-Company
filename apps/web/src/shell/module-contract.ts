export type Edition = 'personal' | 'organization';
export type ActiveProvider = 'aws' | 'gcp' | 'onprem';
export type ModuleManifest = Readonly<{
  id: ActiveProvider;
  name: string;
  icon: string;
  focus: { ko: string; en: string };
  mobile: boolean;
}>;
