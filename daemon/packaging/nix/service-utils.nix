{ lib }:
{
  # Validate the string without touching the filesystem or copying private state.
  validPrivateDir = path:
    let
      components = lib.splitString "/" path;
      normalized = "/" + lib.concatStringsSep "/" (builtins.filter (part: part != "" && part != ".") components);
    in
      (lib.hasPrefix "/" path || lib.hasPrefix "%h/" path)
      && !(builtins.elem ".." components)
      && builtins.match "[^\r\n]*" path != null
      && normalized != builtins.storeDir
      && !(lib.hasPrefix "${builtins.storeDir}/" normalized);

  environmentValue = value:
    "\"" + builtins.replaceStrings [ "\\" "\"" ] [ "\\\\" "\\\"" ] value + "\"";
}
