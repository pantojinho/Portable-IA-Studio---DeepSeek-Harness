@echo off
rem Duplo clique aqui para abrir o AI Studio.
title AI Studio
cd /d "%~dp0"
call "%~dp0aistudio.cmd" serve %*
if errorlevel 1 pause
