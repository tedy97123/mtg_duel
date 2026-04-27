(() => {
  const inst = window.__PLAYTESTER_INSTANCE__;
  if (!inst) {
    console.error('Run check-counter-sync.js first');
    return;
  }

  console.log('=== handleSaveData ===');
  console.log(inst.handleSaveData.toString());

  console.log('\n=== handleRestoreSaveState ===');
  console.log(inst.handleRestoreSaveState.toString());

  console.log('\n=== getInitialState ===');
  console.log(inst.getInitialState.toString());
})();
