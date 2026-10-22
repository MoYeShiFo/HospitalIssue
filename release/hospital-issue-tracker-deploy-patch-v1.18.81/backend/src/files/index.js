import { config } from '../config.js';
import { createDevFileStore } from './devFileStore.js';
import { createMssqlFileStore } from './mssqlFileStore.js';

let store;

// 工厂：dev 用 JSON 文件，生产用 SQL Server（模块级缓存）。
export async function getFileStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevFileStore(config.filesDevPath)
    : createMssqlFileStore(config.mssql);
  await store.init();
  return store;
}
