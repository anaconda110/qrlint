' Launch the QRLink GUI with no console window.
' Invoked by the desktop / Start Menu / SendTo shortcuts (see README).
'
' Python interpreter lookup order:
'   1. %QRLINK_PYTHONW%  (set this if pythonw.exe lives somewhere unusual)
'   2. C:\ProgramData\anaconda3\pythonw.exe  (default Anaconda install)
'   3. pythonw.exe on PATH
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

pyw = sh.ExpandEnvironmentStrings("%QRLINK_PYTHONW%")
If pyw = "%QRLINK_PYTHONW%" Then pyw = ""
If pyw = "" Or Not fso.FileExists(pyw) Then
  pyw = "C:\ProgramData\anaconda3\pythonw.exe"
  If Not fso.FileExists(pyw) Then pyw = "pythonw.exe"
End If

sh.Run """" & pyw & """ """ & here & "\qrlink.py""", 0, False
