<script setup>
import { ref } from 'vue';
import { api } from '../api.js';
import { APP_VERSION } from '../version.js';

const emit = defineEmits(['loggedIn']);
// v1.18.51：登录页固定显示系统名称，不再读取机构级 appName 配置
//（appName 可能被配置成医院名，自动退回登录时不希望暴露/混淆）。
const FIXED_TITLE = '软件问题登记系统';
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  if (!username.value || !password.value) { error.value = '请输入用户名和密码'; return; }
  loading.value = true;
  try {
    const { token, user, org, orgs } = await api.login(username.value, password.value);
    emit('loggedIn', { token, user, org, orgs });
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-mask">
    <div class="login-card">
      <h2>{{ FIXED_TITLE }}</h2>
      <p class="sub">请登录后使用</p>
      <label>用户名<input v-model="username" @keyup.enter="submit" autofocus /></label>
      <label>密码<input v-model="password" type="password" @keyup.enter="submit" /></label>
      <p v-if="error" class="err">{{ error }}</p>
      <button class="primary" :disabled="loading" @click="submit">{{ loading ? '登录中…' : '登录' }}</button>
    </div>
    <!-- v1.18.34：登录页底部版权信息 + 版本号 -->
    <div class="login-foot">© 2026 软件问题登记系统 · 版权所有　{{ APP_VERSION }}</div>
  </div>
</template>
