@echo off
chcp 936 >nul
title 医院信息科 - 软件问题登记系统 [启动]
cd /d "%~dp0"

REM 启动追踪日志（任何提前退出都会留下痕迹，便于排查）
echo [%date% %time%] cwd=%cd% dp0=%~dp0 > boot.log
echo [%date% %time%] 启动脚本开始 >> boot.log

echo ============================================================
echo    医院信息科 - 软件问题登记系统  [启动]
echo ------------------------------------------------------------
echo    当前目录 : %cd%
echo    访问地址 : http://localhost:3000
echo    停止方式 : 关闭本窗口 或 Ctrl+C
echo ============================================================
echo.

REM 1) 定位 node（优先 runtime\node.exe，其次 PATH / 常见安装位置）
call :FindNode
echo [%date% %time%] NODE_BIN=%NODE_BIN% >> boot.log
if not defined NODE_BIN (
  color 0C
  echo [错误] 未找到 node.exe。
  echo        应当随包自带 runtime\node.exe，请确认解压完整。
  echo        或在系统安装 Node.js 18+ 并确保 node 在 PATH 中。
  echo.
  pause
  exit /b 1
)

REM 2) Visual C++ 运行库自检（node 起不来多半是缺 VC++ redist）
"%NODE_BIN%" -v >nul 2>&1
echo [%date% %time%] node -v exit=%errorlevel% >> boot.log
if %errorlevel% neq 0 (
  color 0C
  echo [错误] 运行 node 失败，通常是缺少 Visual C++ 运行库。
  echo        请安装 Microsoft Visual C++ 2015-2022 Redistributable x64：
  echo        https://aka.ms/vs/17/release/vc_redist.x64.exe
  echo        安装后重新双击本脚本即可。
  echo.
  pause
  exit /b 1
)

REM 3) 依赖自检（backend\node_modules 缺失则尝试自动 npm 安装）
if not exist "backend\node_modules\cors\package.json" (
  echo [信息] 未检测到 backend\node_modules，尝试自动安装依赖...
  echo [%date% %time%] node_modules 缺失，尝试 npm install >> boot.log
  call :FindNpm
  if defined NPM_BIN (
    cd backend
    call "%NPM_BIN%" install --production
    cd ..
  ) else (
    color 0C
    echo [错误] 依赖缺失且找不到 npm，无法自动安装。
    echo        请重新解压完整包，内含 backend\node_modules，
    echo        或在系统安装 Node.js 后运行 tools\install.bat。
    echo.
    pause
    exit /b 1
  )
) else (
  echo [%date% %time%] node_modules 已存在 >> boot.log
)

REM 4) 端口占用检查
set "PORT_PID="
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr /i "LISTENING"') do (
  set "PORT_PID=%%a"
)
if defined PORT_PID (
  color 0E
  echo [提示] 端口 3000 已被进程 PID=%PORT_PID% 占用，可能已有本系统或其它程序在运行。
  echo        请先停止占用 3000 的进程再启动：
  echo          - 任务管理器结束 PID=%PORT_PID%，或命令行  taskkill /PID %PORT_PID% /F
  echo          - 若是本系统旧窗口或服务，关闭它即可
  echo        也可直接访问 http://localhost:3000 验证是否已在运行。
  echo.
  echo [%date% %time%] 端口 3000 被 PID=%PORT_PID% 占用，退出 >> boot.log
  pause
  exit /b 0
) else (
  echo [%date% %time%] 端口 3000 空闲 >> boot.log
)

echo [信息] 正在以免数据库模式启动，数据存 JSON 文件...
echo [信息] 启动日志写入 server.log，成功后访问 http://localhost:3000
echo.

cd backend
set _enc=0
if exist "src\index.js.enc" if not exist "src\index.js" set _enc=1
if %_enc%==1 (
    echo [switch] 检测到加密源码，使用 loader 启动...
    ..\runtime\node.exe --import ./loader.mjs start-enc.mjs > ..\server.log 2>&1
) else (
    ..\runtime\node.exe start3000.mjs > ..\server.log 2>&1
)

echo.
echo [信息] node 进程已退出，退出码 %errorlevel%
echo [%date% %time%] node 退出码 %errorlevel% >> boot.log
if not %errorlevel%==0 (
  echo ============================================================
  echo [错误] 启动失败，server.log 末尾如下：
  echo ============================================================
  type ..\server.log
  echo.
  echo 也可直接打开 server.log 文件查看完整报错，并把内容发给我。
)
pause
goto :eof

:FindNode
set NODE_BIN=
if exist "runtime\node.exe" set NODE_BIN=runtime\node.exe
if not defined NODE_BIN (
  for /f "delims=" %%i in ('where node 2^>nul') do ( set NODE_BIN=%%i & goto :NodeFound )
)
:NodeFound
if not defined NODE_BIN if exist "C:\Program Files\nodejs\node.exe" set NODE_BIN=C:\Program Files\nodejs\node.exe
if not defined NODE_BIN if exist "C:\Program Files (x86)\nodejs\node.exe" set NODE_BIN=C:\Program Files (x86)\nodejs\node.exe
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\node\node.exe" set NODE_BIN=%LOCALAPPDATA%\Programs\node\node.exe
goto :eof

:FindNpm
set NPM_BIN=
if exist "runtime\npm.cmd" set NPM_BIN=runtime\npm.cmd
if not defined NPM_BIN (
  for /f "delims=" %%i in ('where npm 2^>nul') do ( set NPM_BIN=%%i & goto :NpmFound )
)
:NpmFound
if not defined NPM_BIN if exist "C:\Program Files\nodejs\npm.cmd" set NPM_BIN=C:\Program Files\nodejs\npm.cmd
if not defined NPM_BIN if exist "C:\Program Files (x86)\nodejs\npm.cmd" set NPM_BIN=C:\Program Files (x86)\nodejs\npm.cmd
if not defined NPM_BIN if exist "%LOCALAPPDATA%\Programs\node\npm.cmd" set NPM_BIN=%LOCALAPPDATA%\Programs\node\npm.cmd
goto :eof
