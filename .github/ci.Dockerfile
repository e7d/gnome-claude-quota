FROM archlinux:base@sha256:e82623936fa1a69700b48e98b058df6eaab18b737c27473a7234a40fdecb9413

RUN --mount=type=cache,target=/var/cache/pacman/pkg \
    pacman -Syu --noconfirm --needed \
        adwaita-icon-theme \
        cantarell-fonts \
        dbus \
        dconf \
        diffutils \
        gnome-backgrounds \
        gnome-shell \
        imagemagick \
        mesa \
        nodejs \
        noto-fonts \
        noto-fonts-emoji \
        npm \
        python-dbusmock \
        shellcheck \
        ttf-dejavu \
    && rm -rf /var/lib/pacman/sync/* \
    && fc-cache -f \
    && useradd -m ci \
    && install -d -m 700 -o ci -g ci /run/user/1000 \
    && install -d -o ci -g ci /work

ENV XDG_RUNTIME_DIR=/run/user/1000
USER ci
WORKDIR /work
