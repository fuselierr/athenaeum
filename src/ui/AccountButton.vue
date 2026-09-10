<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { account, displayName } from '../state/account.js';
import { signInWith, signOut } from '../auth/session.js';

/**
 * The account control, top right.
 *
 * Always on screen, menu open or not, so it is mounted on its own (see
 * ui/mountAccount.js) rather than inside the menu's overlay. Signed out, it
 * opens a small panel offering Google and Discord. Signed in, it shows who
 * you are and the same panel offers a way out.
 */

const open = ref(false);
const root = ref(null);

const name = computed(() => displayName(account.user));
const avatar = computed(() => account.user?.user_metadata?.avatar_url ?? null);
const initial = computed(() => name.value.trim().charAt(0).toUpperCase());

/** Is a redirect to this provider the one in flight? */
function opening(provider) {
  return account.busy && account.provider === provider;
}

async function leave() {
  await signOut();
  open.value = false;
}

// A press anywhere else closes the panel. Capture phase, because the room's
// own gestures stop propagation on the canvas, and a click on the room
// should still dismiss this.
function onPointerDown(event) {
  if (open.value && root.value && !root.value.contains(event.target)) open.value = false;
}
onMounted(() => window.addEventListener('pointerdown', onPointerDown, { capture: true }));
onBeforeUnmount(() => window.removeEventListener('pointerdown', onPointerDown, { capture: true }));
</script>

<template>
  <div v-if="account.ready" ref="root" class="account">
    <button
      v-if="!account.user"
      class="account-trigger"
      type="button"
      :disabled="!account.available"
      :title="account.available ? 'Sign in' : account.error"
      @click="open = !open"
    >Sign in</button>

    <button
      v-else
      class="account-trigger signed-in"
      type="button"
      :title="name"
      @click="open = !open"
    >
      <img v-if="avatar" :src="avatar" alt="" class="account-avatar" referrerpolicy="no-referrer">
      <span v-else class="account-avatar account-initial">{{ initial }}</span>
      <span class="account-name">{{ name }}</span>
    </button>

    <div v-if="open" class="account-panel" role="dialog" aria-label="Account">
      <template v-if="!account.user">
        <p class="account-heading">Sign in to Athenaeum</p>
        <button class="account-provider account-google" type="button" :disabled="account.busy"
                @click="signInWith('google')">
          <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          <span>{{ opening('google') ? 'Opening Google…' : 'Continue with Google' }}</span>
        </button>

        <button class="account-provider account-discord" type="button" :disabled="account.busy"
                @click="signInWith('discord')">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
          </svg>
          <span>{{ opening('discord') ? 'Opening Discord…' : 'Continue with Discord' }}</span>
        </button>

        <p class="account-note">First time here? Signing in with either creates your account.</p>
      </template>

      <template v-else>
        <p class="account-heading">{{ name }}</p>
        <p v-if="account.user.email" class="account-note">{{ account.user.email }}</p>
        <button class="account-signout" type="button" :disabled="account.busy" @click="leave">
          Sign out
        </button>
      </template>

      <p v-if="account.error" class="account-error">{{ account.error }}</p>
    </div>
  </div>
</template>

<style scoped>
.account {
  position: fixed;
  top: 12px;
  right: 12px;
  /* Above the menu's scrim (10), so it stays usable with the menu open. */
  z-index: 11;
  font: 13px/1.5 system-ui, sans-serif;
  color: #cfd6e4;
}

.account-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 14px;
  background: rgba(20, 24, 32, 0.75);
  color: #e7ecf5;
  border: 1px solid #2c3444;
  border-radius: 17px;
  font: inherit;
  cursor: pointer;
  backdrop-filter: blur(4px);
}
.account-trigger:hover:not(:disabled) { background: rgba(38, 45, 60, 0.9); }
.account-trigger:disabled { opacity: 0.5; cursor: default; }
.account-trigger.signed-in { padding: 0 12px 0 4px; }

.account-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  object-fit: cover;
}
.account-initial {
  display: grid;
  place-items: center;
  background: #3d4a63;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.account-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 260px;
  padding: 14px;
  background: rgba(18, 21, 28, 0.97);
  border: 1px solid #2c3444;
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
}

.account-heading {
  margin: 0 0 10px;
  color: #fff;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.account-note {
  margin: 10px 0 0;
  color: #7f89a0;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.account-provider {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  height: 38px;
  border-radius: 6px;
  font: 500 13px/1 system-ui, sans-serif;
  cursor: pointer;
}
.account-provider + .account-provider { margin-top: 8px; }
.account-provider:disabled { opacity: 0.6; cursor: default; }

/* Each in its own brand's colours, which is how both ask for their
   sign-in buttons to appear. */
.account-google {
  background: #fff;
  color: #1f1f1f;
  border: 1px solid #dadce0;
}
.account-google:hover:not(:disabled) { background: #f3f5f8; }

.account-discord {
  background: #5865f2;
  color: #fff;
  border: 1px solid #5865f2;
}
.account-discord:hover:not(:disabled) { background: #4752c4; border-color: #4752c4; }

.account-signout {
  width: 100%;
  margin-top: 12px;
  padding: 7px 12px;
  background: #303a4e;
  color: #e7ecf5;
  border: 1px solid #3d4a63;
  border-radius: 6px;
  font: inherit;
  cursor: pointer;
}
.account-signout:hover:not(:disabled) { background: #3b4761; }
.account-signout:disabled { opacity: 0.45; cursor: default; }

.account-error {
  margin: 10px 0 0;
  color: #ff8a8a;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>