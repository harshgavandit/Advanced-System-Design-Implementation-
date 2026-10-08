# Scoped Windows power request for an uninterrupted local verification interval.
function Initialize-VerificationPowerGuard {
  if (-not $IsWindows) { throw 'The local power guard requires Windows and PowerShell 7' }
  if ($null -eq ('ScalingLabVerification.PowerGuard' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace ScalingLabVerification {
  [StructLayout(LayoutKind.Sequential)]
  public struct PowerStatus {
    public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
    public UInt32 BatteryLifeTime, BatteryFullLifeTime;
  }
  public static class PowerGuard {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UInt32 SetThreadExecutionState(UInt32 flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemPowerStatus(out PowerStatus status);
    public static PowerStatus ReadStatus() {
      PowerStatus status;
      if (!GetSystemPowerStatus(out status)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return status;
    }
    public static UInt32 Acquire() {
      UInt32 previous = SetThreadExecutionState(0x80000001u);
      if (previous == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      return previous;
    }
    public static void Release(UInt32 previous) {
      if (SetThreadExecutionState(previous) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
  }
}
function Start-VerificationPowerGuard {
  param([switch]$RequireExternalPower)
  Initialize-VerificationPowerGuard
  $powerStatus = [ScalingLabVerification.PowerGuard]::ReadStatus()
  if ($RequireExternalPower -and $powerStatus.ACLineStatus -ne 1) {
    throw 'A four-hour Windows soak requires external power. Connect power before starting the measured profile.'
  }
  [pscustomobject]@{
    PreviousState = [ScalingLabVerification.PowerGuard]::Acquire()
    ACLineStatus = $powerStatus.ACLineStatus
    BatteryPercent = $powerStatus.BatteryLifePercent
  }
}
function Stop-VerificationPowerGuard {
  param([Parameter(Mandatory)][uint32]$PreviousState)
  [ScalingLabVerification.PowerGuard]::Release($PreviousState)
}
