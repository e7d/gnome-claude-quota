FROM archlinux:base

ARG GNOME_VERSION=unset

RUN --mount=type=cache,target=/var/cache/pacman/pkg \
    echo "building for gnome-shell ${GNOME_VERSION}" \
    && pacman -Syu --noconfirm --needed \
        adwaita-icon-theme \
        cantarell-fonts \
        dbus \
        dconf \
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
