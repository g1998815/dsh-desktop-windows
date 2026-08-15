' start.vbs — 双击启动 DSH 桌面版(隐藏控制台窗口,调用 electron .)
' 由 Windows 脚本宿主(WScript.exe)运行,不弹出命令行窗口。
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir
' 0 = 隐藏窗口,False = 不等待命令结束
shell.Run "cmd /c npm start", 0, False
