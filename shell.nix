{
  pkgs ? import <nixpkgs> {
    config = {
      allowUnfree = true;
    };
  },
}:
pkgs.mkShell {
  buildInputs = with pkgs; [
    mongodb-tools
    yarn
  ];

  shellHook = ''
    set -a
    source .env

    echo "🧗 Alle!"
  '';
}
