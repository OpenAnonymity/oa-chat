{ config, lib, pkgs, ... }:
let
  cfg = config.services.oa-chat;
  serviceUtils = import ./service-utils.nix { inherit lib; };
in {
  options.services.oa-chat = {
    enable = lib.mkEnableOption "Open Anonymity as an explicitly selected user's service";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The daemon and its matching companion/proof package.";
    };
    users = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "alice" ];
      description = "Login users allowed to start the service with their own initialized wallet.";
    };
    configDir = lib.mkOption {
      type = lib.types.str;
      default = "%h/.config/oa-chat";
      description = ''
        Runtime private configuration directory; systemd expands %h to each user's home.
        Initialize this directory with oa-chat init before starting the service.
        Never use a Nix store path or embed credentials or wallet contents in Nix.
      '';
    };
    startAtLogin = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Start for the selected users at login after their configuration exists.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = cfg.users != [ ]; message = "services.oa-chat.users must explicitly select at least one login user."; }
      { assertion = builtins.all (user: builtins.match "[a-zA-Z_][a-zA-Z0-9_.-]*" user != null && user != "root") cfg.users;
        message = "services.oa-chat.users must contain non-root login user names."; }
      { assertion = serviceUtils.validPrivateDir cfg.configDir;
        message = "services.oa-chat.configDir must be an absolute runtime directory outside the Nix store (or start with %h/), without parent-directory components."; }
    ];
    environment.systemPackages = [ cfg.package ];
    systemd.user.services.oa-chat = {
      description = "Open Anonymity local inference API";
      documentation = [ "https://github.com/OpenAnonymity/oa-chat" ];
      wantedBy = lib.optionals cfg.startAtLogin [ "default.target" ];
      unitConfig = {
        # Repeated trigger conditions are ORed; a single joined username is invalid.
        ConditionUser = map (user: "|${user}") cfg.users;
        ConditionPathExists = "${cfg.configDir}/config.json";
        StartLimitIntervalSec = 60;
        StartLimitBurst = 5;
      };
      environment.OA_CHAT_CONFIG_DIR = cfg.configDir;
      serviceConfig = {
        Type = "simple";
        ExecStart = "${cfg.package}/bin/oa-chat serve";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStopSec = 30;
        UMask = "0077";
        NoNewPrivileges = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };
    };
  };
}
