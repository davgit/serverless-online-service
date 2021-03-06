import { UserConfig } from '@hint/utils';

export interface IServiceConfig {
    /** List of webhint configurations to split the job in messages. */
    webhintConfigs: UserConfig[];
    /** Time in seconds to keep a job in the cache. */
    jobCacheTime: number;
    /** Time in seconds a job has to complete the execution in webhint. */
    jobRunTime: number;
    /** Configuration name. */
    name: string;
    /** Indicates if a configuration is the active one or not. */
    active: boolean;
}

export type ConfigData = {
    name: string;
    jobCacheTime: number;
    jobRunTime: number;
    filePath: string;
};
