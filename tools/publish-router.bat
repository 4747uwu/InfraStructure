@echo off
:: Builds a client's router and uploads the installer to Router Hub.
::
::   publish-router.bat "D:\work\Go exe\KENYA" -Client "Kenya"
::   publish-router.bat "D:\work\Go exe\GANESHAM" -Notes "API failover fix"
::   publish-router.bat "D:\work\Go exe\RADX1" -SkipBuild
::
:: Run with no folder to publish the project in the current directory.
:: All options are documented at the top of publish-router.ps1.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-router.ps1" %*
exit /b %ERRORLEVEL%
