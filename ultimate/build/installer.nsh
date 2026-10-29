; build/installer.nsh — NSIS hooks for the Ganesham Teleradiology installer.
;
; Two jobs, both learned the hard way:
;
;   1. Kill the app AND the sender before installing or uninstalling. Electron
;      holds its profile folder open; the Go engine is a child of Electron and
;      is not always reaped when the app exits, and while it runs it holds
;      tarang.db, today's log file, and its own binary open. Either one makes
;      RMDir /r fail silently, which leaves an "upgrade" with the OLD exe in
;      place next to the new UI, and an uninstall with the profile intact.
;
;   2. Purge %APPDATA% on a genuine uninstall, under BOTH shell contexts and
;      including every name this product has shipped under. Leftovers from a
;      previous name caused reinstalls to come back holding a stale config and
;      a stale queue, which presents as "the app reinstalled itself out of
;      sync".
;
; Note both folder conventions are purged for each name: Electron derives
; userData from package.json "name" (the kebab form, e.g. ganesham-teleradiology —
; this is what is actually observed on disk), but "productName" ("Ganesham
; Teleradiology") is
; the documented behaviour and appears on some builds. Deleting both costs one
; line each and removes the guesswork.

; Order matters here, and it is the order things hold files in.
;
; The UI goes FIRST. Electron keeps Cache, Local State, Local Storage and
; Network open inside the very %APPDATA% folder purgeAppData is about to
; delete, so killing only the engine left the app holding the folder open and
; every RMDir /r below failed SILENTLY — NSIS does not fail an uninstall for a
; directory it could not remove. That is half of why "uninstall left AppData
; behind": even with the right path, the folder was in use.
;
; Then the engine, which holds tarang.db, today's log file and its own binary
; (it is a child of Electron and is not always reaped), then gdcmconv, which a
; transcode may still be running.
!macro killSender
  ; ${APP_EXECUTABLE_FILENAME} rather than a literal: a second variant built
  ; from this tree ships as its own product with its own exe name, and each
  ; installer must stop ITS product — not the other one, which may be mid
  ; transfer, and not nothing at all.
  DetailPrint "Stopping ${PRODUCT_NAME}..."
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'

  DetailPrint "Stopping ${PRODUCT_NAME} background service..."
  ; Killing the engine by image name is safe again, because the name is now
  ; unique to this product -- see SENDER_EXE_NAME in electron/main/main.js.
  ; It used to be shared by every build of this codebase, which is why this
  ; was a blanket `taskkill /IM tarang-sender.exe` that reached into other
  ; products' engines mid-transfer. Each installer now stops only its own.
  ;
  ; Deliberately NOT tarang-sender.exe or any other product's engine name:
  ; Ganesham Teleradiology has never shipped under another name, and those
  ; images belong to other products built from this codebase that may be
  ; installed, and mid-transfer, on the same machine.
  !if "${APP_PACKAGE_NAME}" == "ganesham-teleradiology2"
    nsExec::Exec 'taskkill /F /IM "ganesham2-sender.exe" /T'
  !else
    nsExec::Exec 'taskkill /F /IM "ganesham-sender.exe" /T'
  !endif

  nsExec::Exec 'taskkill /F /IM gdcmconv.exe /T'

  ; Give Windows a moment to release the file handles before we touch the
  ; install directory; without this the very next RMDir can still fail. Two
  ; seconds because there are now three processes to reap, not one.
  Sleep 2000
!macroend

; purgeAppDataPaths deletes every %APPDATA% / %LOCALAPPDATA% folder this
; product line has ever written, under whatever shell context is currently in
; effect. It is a macro rather than a function so it can be inserted twice —
; see purgeAppData.
!macro purgeAppDataPaths
    ; This product, whichever variant it is. Never a literal: variant 2's
    ; uninstaller purging "ganesham-teleradiology" would delete variant 1's config and
    ; queue while variant 1 is still installed and running.
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"

    ; Named second instances (--instance=<id>) write ganesham-teleradiology-<id>, so the
    ; set of profile folders is open-ended and cannot be listed here. Walk the
    ; wildcard instead, or an uninstall leaves every extra instance's config
    ; and queue behind — the same "reinstall comes back out of sync" failure
    ; the list above exists to prevent.
    ;
    ; Relative jumps, NOT labels: this macro is inserted twice (once per shell
    ; context) and duplicate labels will not assemble. $0/$1 are saved because
    ; the uninstaller's other macros use them too.
    Push $0
    Push $1
    FindFirst $0 $1 "$APPDATA\${APP_PACKAGE_NAME}-*"
    StrCmp $1 "" +4
    RMDir /r "$APPDATA\$1"
    FindNext $0 $1
    Goto -3
    FindClose $0
    Pop $1
    Pop $0

    ; Previous names of THIS product. Ganesham Teleradiology has shipped under
    ; no other name, so there are none yet. The folders of other products
    ; built from this codebase (Achyu PACS, QuickOn PACS, BharatPACS Sender,
    ; ...) are intentionally NOT purged: they may be installed alongside this
    ; one, and deleting their %APPDATA% would wipe another product's config
    ; and queue.
    ;
    ; !! IF THIS PRODUCT IS RENAMED, READ THIS FIRST !!
    ; Add the OUTGOING name here (and to the taskkill list in killSender), or
    ; an in-place upgrade leaves the old config, queue and engine behind and
    ; the reinstall comes back out of sync. A project-wide find-and-replace
    ; will not do this for you.

    ; Updater caches, which otherwise resurrect an old build.
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
!macroend

; The installer is perMachine:true, so electron-builder's uninstaller runs with
; SetShellVarContext all. Under that context NSIS resolves $APPDATA to
; C:\ProgramData — NOT the user's Roaming folder. Every RMDir /r here used to
; target a path that had never existed, report success, and leave the real
; profile untouched:
;
;   C:\Users\<user>\AppData\Roaming\ganesham-teleradiology\ganesham\data
;
; That is the folder the engine's own log names as data_dir, and it is the one
; that survived every uninstall. So the purge runs under BOTH contexts: "all"
; for the ProgramData copy, "current" for the Roaming one.
;
; Caveat that cannot be fixed from here: an elevated uninstall runs as the
; administrator account, so "current" is the ADMIN's profile. If a different
; account installed and used the app, its Roaming folder is not reachable from
; the uninstaller at all and has to be deleted by hand.
!macro purgeAppData
  DetailPrint "Removing application data..."

  SetShellVarContext all
  !insertmacro purgeAppDataPaths

  SetShellVarContext current
  !insertmacro purgeAppDataPaths

  ; Leave the context as the uninstaller expects to find it.
  SetShellVarContext all
!macroend

; ---------------------------------------------------------------------------
; Trusted root installation
;
; The backend hosts (pacs/router/viewer on ganeshamteleradiology.in and their
; *.xcentic.com backups, which share one ECDSA certificate) present this chain:
;
;   ganeshamteleradiology.xcentic.com -> Let's Encrypt YE1 -> Root YE (ISRG)
;                                     -> ISRG Root X2 -> ISRG Root X1
;
; ISRG Root X2 is not in the default Windows 7 root store. This chain does
; serve an X2 cross-signed by ISRG Root X1, so a box that trusts X1 can build
; a path without any help from us — but X1 is itself absent from an un-updated
; Win7 root store, so on exactly the machines this installer targets there is
; still no fallback: every HTTPS call fails, the login screen shows "Failed to
; fetch", and the engine cannot reach the backend. Importing X2 directly is
; what makes those boxes work, and it costs nothing on a machine that already
; trusts either root.
;
; One store fixes both halves of the product: Chromium 108 (Electron 22)
; verifies against the OS root store, and Go on Windows verifies through
; CryptoAPI. So this single import covers the UI and the engine alike.
;
; certutil ships with Windows 7 and accepts DER.
;
; Two stores are attempted, in this order:
;
;   1. LocalMachine root — needs admin, and is SILENT when we have it. This is
;      why the installer is built perMachine:true; see package.json.
;   2. CurrentUser root  — needs no privileges, but Windows raises its own
;      "You are about to install a certificate from a certification
;      authority" trust dialog, which the operator can decline. Verified: an
;      unelevated add returns 0x800704c7 ERROR_CANCELLED when they do.
;
; So the machine store is not merely the tidier option, it is the only one
; that installs without putting a security warning in front of the operator
; mid-setup. The user store stays as a fallback because a prompt the operator
; can accept still beats an outright failure on a locked-down box.
!macro installTrustedRoots
  DetailPrint "Installing certificate authority (ISRG Root X2)..."
  SetOutPath "$INSTDIR\certs"
  File "${BUILD_RESOURCES_DIR}\certs\isrg-root-x2.der"

  nsExec::ExecToStack 'certutil -addstore -f root "$INSTDIR\certs\isrg-root-x2.der"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    DetailPrint "Certificate authority installed for all users."
  ${Else}
    DetailPrint "Machine store unavailable ($0) - installing for the current user."
    nsExec::ExecToStack 'certutil -addstore -f -user root "$INSTDIR\certs\isrg-root-x2.der"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      DetailPrint "Certificate authority installed for the current user."
    ${Else}
      ; Deliberately not fatal. On a machine that already trusts the root —
      ; every Win10/11 box — this adds nothing, and a failure here must not
      ; block an otherwise good install. It is recorded so it can be found.
      DetailPrint "Certificate import failed ($0), continuing: $1"
    ${EndIf}
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; Standard-user accounts
;
; This is a per-machine installer: it writes to Program Files and to the
; machine certificate store, so it needs an administrator. Windows normally
; asks for one before the installer starts. With User Account Control turned
; off it does not: the installer starts with a Standard user's rights and
; fails at the first file it writes ("Error opening file for writing:
; ...\uninstallerIcon.ico"). So check first, and if this account is not an
; administrator, open Windows' "Run as different user" box to start the
; installer again as one.
;
; preInit runs before the installer takes its single-instance lock, so the
; copy started as the administrator is not turned away by this one. It is
; skipped while the build generates the uninstaller (BUILD_UNINSTALLER).
!macro requireAdministrator
  ${IfNot} ${UAC_IsAdmin}
    ${If} ${Silent}
      SetErrorLevel 740 ; ERROR_ELEVATION_REQUIRED
      Quit
    ${EndIf}

    ReadEnvStr $0 USERNAME
    ${IfNot} ${Cmd} `MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION|MB_TOPMOST "${PRODUCT_NAME} must be installed by a Windows administrator.$\r$\n$\r$\nThis account ($0) is a Standard user. Click OK and sign in with an administrator account to continue the installation." IDOK`
      SetErrorLevel 1223 ; ERROR_CANCELLED
      Quit
    ${EndIf}

    ; Wait rather than quit straight away: Windows opens the sign-in box from
    ; this process, and quitting at once can close it before it appears.
    ${GetParameters} $1
    ClearErrors
    ExecShellWait "runasuser" "$EXEPATH" "$1"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONINFORMATION|MB_TOPMOST "${PRODUCT_NAME} was not installed.$\r$\n$\r$\nTo install it, either log in to Windows with an administrator account and run this installer, or hold Shift, right-click the installer, choose $\"Run as different user$\" and sign in with an administrator account."
      SetErrorLevel 740
    ${EndIf}
    Quit
  ${EndIf}
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    !insertmacro requireAdministrator
  !endif
!macroend

!macro customInit
  !insertmacro killSender
!macroend

!macro customInstall
  !insertmacro installTrustedRoots
!macroend

!macro customUnInit
  !insertmacro killSender
!macroend

!macro customRemoveFiles
  !insertmacro killSender
  RMDir /r "$INSTDIR"
!macroend

!macro customUnInstall
  ; The trusted root is deliberately NOT removed here. It is a public CA root
  ; that other software on the machine may now be relying on, and pulling it
  ; on uninstall could break something we never installed.
  ;
  ; ${isUpdated} is true when the uninstaller runs as part of an upgrade. The
  ; whole point of an upgrade is that the operator keeps their login, their
  ; settings and any studies still queued, so the purge must NOT run then.
  ${ifNot} ${isUpdated}
    !insertmacro purgeAppData
  ${endIf}
!macroend
