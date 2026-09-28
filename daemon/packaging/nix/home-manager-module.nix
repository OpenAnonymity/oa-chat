{ config, lib, pkgs, ... }:
let
  cfg = config.services.oa-chat;
  serviceUtils = import ./service-utils.nix { inherit lib; };
in {
  options.services.oa-chat = {
    enable = lib.mkEnableOption "Open Anonymity's Linux user service";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The daemon and its matching companion/proof package.";
    };
    configDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.configHome}/oa-chat";
      description = "Runtime private directory initialized separately with oa-chat init; never put credentials or wallet contents in Nix.";
    };
    startAtLogin = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Start the user service at login after its configuration exists.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = pkgs.stdenv.hostPlatform.isLinux; message = "services.oa-chat requires Linux systemd; on macOS use the package with oa-chat serve."; }
      { assertion = lib.hasPrefix "/" cfg.configDir && serviceUtils.validPrivateDir cfg.configDir;
        message = "services.oa-chat.configDir must be an absolute runtime directory outside the Nix store, without parent-directory components."; }
    ];
    home.packages = [ cfg.package ];
    systemd.user.services.oa-chat = {
      Unit = {
        Description = "Open Anonymity local inference API";
        Documentation = [ "https://github.com/OpenAnonymity/oa-chat" ];
        ConditionPathExists = "${cfg.configDir}/config.json";
        StartLimitIntervalSec = 60;
        StartLimitBurst = 5;
      };
      Service = {
        Type = "simple";
        ExecStart = "${cfg.package}/bin/oa-chat serve";
        Environment = [ (serviceUtils.environmentValue "OA_CHAT_CONFIG_DIR=${cfg.configDir}") ];
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStopSec = 30;
        UMask = "0077";
        NoNewPrivileges = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };
      Install.WantedBy = lib.optionals cfg.startAtLogin [ "default.target" ];
    };
  };
}
