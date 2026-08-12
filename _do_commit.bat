@echo off
cd /d d:\python\cherrystudio-for-houdini\web
git add -A
git commit -F COMMIT_MSG.txt
set EXITCODE=%ERRORLEVEL%
if exist COMMIT_MSG.txt del COMMIT_MSG.txt
exit /b %EXITCODE%
