/* 広告枠の設定（ここ1か所だけ）。
   いまは「枠」だけを表示します。広告スクリプトの読み込み・外部への通信・IDは一切ありません。
   将来 AdSense を入れるときは provider / client / 各 slotId をここに入れ、別途 CSP（index.html）と読み込み処理を追加します。
   表示する条件は iOS 版と同じ（app.js の adGate を参照）:
     banner       … タブバーの下 320×50（全タブ共通。全画面表示・プラン画面・インタースティシャル表示中は隠れる）
     native       … 素材分析のいちばん下（区切り線の下）
     reward       … 「広告を見てFullを1回試す」ボタン（素材ボタンの上）
     interstitial … 書き出し完了時（前回から2回以上の操作があったときだけ。再生中は出さない） */
window.PM_ADS = Object.freeze({
  provider: null,   // 例: 'adsense'（未設定の間は枠だけ）
  client: '',       // 例: AdSense のパブリッシャーID（未設定）
  label: '広告',
  slots: Object.freeze({
    banner:       Object.freeze({ enabled: true, slotId: '', width: 320, height: 50 }),
    native:       Object.freeze({ enabled: true, slotId: '' }),
    reward:       Object.freeze({ enabled: true, slotId: '' }),
    interstitial: Object.freeze({ enabled: true, slotId: '', minActions: 2 }),
  }),
});
