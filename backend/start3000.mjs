// 启动入口：以 backend/.env 为准（v1.18.67 修复：不再硬编码 DB_DRIVER）。
//
// 旧版这里曾硬编码 process.env.DB_DRIVER = 'dev'，由于 dotenv 不会覆盖已存在的
// 环境变量，导致 .env 里的 DB_DRIVER=mssql 被无视、双击启动永远进免数据库模式。
// 现改为：先加载 .env；仅当 .env 未配置 DB_DRIVER 时才缺省 dev（双击即跑、免数据库）。
import dotenv from 'dotenv';
dotenv.config();
if (!process.env.DB_DRIVER) process.env.DB_DRIVER = 'dev';
if (!process.env.PORT) process.env.PORT = '3000';
await import('./src/index.js');
