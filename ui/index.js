/**
 * dsh-remote-access-proxy-ui, node half. The empty apply exists so the plugin
 * appears in the host Loader (and thus in the dsh.client scan roster); the
 * browser half owns the settings card through exports["./client"].
 */
function apply() {}
export { apply }
