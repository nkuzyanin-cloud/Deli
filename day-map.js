/* Courier day map. Yandex data stays in memory, never in the route database/cache. */
(() => {
  'use strict';
  const API_KEY = '0a2b2e45-f90d-4747-bc6c-c0e0234e809a';
  const MODES = {masstransit:'Общественный транспорт',pedestrian:'Пешком',auto:'На автомобиле'};
  let sdkPromise;
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const point = p => Array.isArray(p) && p.length === 2 && p.every(finite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
  const keyOf = p => p.map(v=>v.toFixed(5)).join(',');
  function timeText(seconds) {
    const minutes = Math.max(0,Math.ceil(seconds/60)),h=Math.floor(minutes/60),m=minutes%60;
    return h ? h+' ч'+(m?' '+m+' мин':'') : minutes+' мин';
  }
  function searchAddress(address,city) {
    const text=String(address||'').trim();
    // Keep explicit cities/regions intact. Use the configured city only as search context.
    const parts=text.split(',');
    const explicitCity=parts.length>=3 && /^[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z\s-]+$/.test(parts[0]) && /^[А-ЯЁа-яёA-Za-z]/.test(parts[1].trim()) && !/(?:улиц|проспект|переул|шоссе|бульвар|набереж|площад|проезд|тупик|алле)/i.test(parts[0]);
    if(!city || text.toLocaleLowerCase().includes(city.toLocaleLowerCase()) || /(?:обл(?:асть|\.)|край|республик|(?:^|\s)г\.\s|город\s)/i.test(text) || explicitCity)return text;
    return city+', '+text;
  }
  function loadSDK() {
    if(sdkPromise)return sdkPromise;
    sdkPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const timer=setTimeout(()=>finish(new Error('Карта не загрузилась за 20 секунд. Проверьте интернет и доступность Яндекс Карт.')),20000);
      let settled=false;
      function finish(error) {
        if(settled)return;settled=true;clearTimeout(timer);
        if(error){script.remove();reject(error)}else resolve(window.ymaps);
      }
      script.src='https://api-maps.yandex.ru/2.1/?lang=ru_RU&apikey='+encodeURIComponent(API_KEY);
      script.async=true;
      script.onload=()=>{if(!window.ymaps){finish(new Error('Яндекс не загрузил API карты. Проверьте ключ и ограничение домена.'));return}window.ymaps.ready(()=>finish(),()=>finish(new Error('API карты недоступен для этого ключа или домена.')))};
      script.onerror=()=>finish(new Error('Не удалось загрузить Яндекс Карты. Проверьте интернет, ключ и ограничение домена.'));
      document.head.append(script);
    }).catch(error=>{sdkPromise=null;throw error});
    return sdkPromise;
  }
  class DayMap {
    constructor(root,onModeChange) {
      this.root=root;this.canvas=root.querySelector('.day-map-canvas');this.overlay=root.querySelector('.day-map-status');
      this.status=root.querySelector('.day-map-message');this.eta=root.querySelector('.day-map-eta');this.caption=root.querySelector('.day-map-caption');
      this.detail=root.querySelector('.day-map-error');this.retry=root.querySelector('.day-map-retry');this.onModeChange=onModeChange;
      this.cache=new Map();this.inflight=new Map();this.generation=0;this.mode='masstransit';this.objects=[];
      root.querySelectorAll('[data-map-mode]').forEach(button=>button.addEventListener('click',()=>{
        if(button.dataset.mapMode===this.mode)return;
        this.mode=button.dataset.mapMode;this.onModeChange?.(this.mode);this.update({...this.input,mode:this.mode});
      }));
      this.retry.addEventListener('click',()=>{
        if(this.input && !this.retry.disabled){
          this.retry.disabled=true;setTimeout(()=>{this.retry.disabled=false},15000);
          this.cache.delete(this.signature);this.update(this.input,true);
        }
      });
      window.addEventListener('offline',()=>{this.offline=true;this.cancelView();this.showMessage('Карта и расчёт времени доступны с интернетом.','Ваши записи и отметки работают офлайн.');});
      window.addEventListener('online',()=>{this.offline=false;if(this.input?.visible)this.update(this.input,true)});
      this.observer=new ResizeObserver(()=>{if(this.map && this.canvas.getClientRects().length)this.map.container.fitToViewport();});
      this.observer.observe(this.canvas);
    }
    cancelView() {clearTimeout(this.timer);this.generation++;this.clearMap();this.loadedSignature='';}
    clearMap() {if(this.map)this.map.geoObjects.removeAll();this.objects=[];}
    showMessage(message,detail='') {
      this.overlay.hidden=false;this.status.textContent=message;this.eta.textContent='Время в пути не рассчитано';this.caption.textContent='Расчётный маршрут, не GPS-трек';
      this.detail.textContent=detail;this.detail.hidden=!detail;this.retry.hidden=true;this.root.dataset.state='unavailable';
    }
    update(input,force=false) {
      if(!input)return;
      this.input=input;this.root.hidden=!input.stages?.length;
      if(this.root.hidden){this.cancelView();this.signature='';return}
      this.mode=MODES[input.mode]?input.mode:'masstransit';
      this.root.querySelectorAll('[data-map-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mapMode===this.mode)));
      const stages=input.stages.map((s,i)=>({...s,number:i+1,address:String(s.address||'').trim()}));this.stages=stages;
      this.root.querySelector('.day-map-count').textContent=stages.length+' '+(stages.length%10===1&&stages.length%100!==11?'остановка':stages.length%10>=2&&stages.length%10<=4&&!(stages.length%100>=12&&stages.length%100<=14)?'остановки':'остановок');
      const signature=JSON.stringify([input.date,this.mode,input.city,stages.map(s=>[s.id,s.address])]);
      if(!force&&signature===this.signature){if(this.loadedSignature===signature)this.paint(this.cache.get(signature));return}
      this.signature=signature;this.cancelView();
      const missing=stages.filter(s=>!s.address);
      if(missing.length){this.showMessage('Добавьте адреса, чтобы увидеть маршрут.',missing.map(s=>s.number+'. '+s.title).join(' · '));return}
      if(navigator.onLine===false||this.offline){this.showMessage('Карта и расчёт времени доступны с интернетом.','Ваши записи и отметки работают офлайн.');return}
      if(!input.visible){this.signature='';return}
      const cached=this.cache.get(signature);
      if(cached){this.paint(cached);return}
      this.overlay.hidden=false;this.status.textContent='Строим маршрут…';this.eta.textContent='Рассчитываем время на весь маршрут';this.caption.textContent=MODES[this.mode]+' · без вручения и перерывов';this.detail.hidden=true;this.retry.hidden=true;this.root.dataset.state='loading';
      const generation=this.generation;
      this.timer=setTimeout(()=>this.build(signature,generation,stages,input.city),300);
    }
    async build(signature,generation,stages,city) {
      try {
        const ymaps=await loadSDK();
        if(generation!==this.generation)return;
        if(!this.map){
          this.map=new ymaps.Map(this.canvas,{center:[55.75,37.61],zoom:10,controls:[]},{yandexMapDisablePoiInteractivity:true});
          this.map.behaviors.disable(['drag','scrollZoom','dblClickZoom','multiTouch']);
          // Required copyright and Yandex's built-in map link stay visible.
        }
        let request=this.inflight.get(signature);
        if(!request){request=this.calculate(ymaps,stages,city,this.mode);this.inflight.set(signature,request);}
        const data=await request;
        this.cache.set(signature,data);while(this.cache.size>3)this.cache.delete(this.cache.keys().next().value);
        if(generation===this.generation)this.paint(data);
      } catch(error) {
        if(generation!==this.generation)return;
        this.clearMap();this.showMessage('Яндекс не дал расчёт маршрута.',String(error?.message||'Неизвестная ошибка').replaceAll(API_KEY,'[ключ]'));
        this.retry.hidden=false;this.root.dataset.state='error';
      } finally {this.inflight.delete(signature)}
    }
    async calculate(ymaps,stages,city,mode) {
      const legs=[],locations=[],queries=stages.map(s=>searchAddress(s.address,city));
      // Request groups never exceed the documented ten-point limit, and overlap
      // by one stop. No client/order/phone/note or GPS data is sent to Yandex.
      for(let start=0;start<queries.length-1;start+=9){
        const end=Math.min(start+10,queries.length),data=await this.requestChunk(ymaps,queries.slice(start,end),mode);
        if(data.legs.length!==end-start-1)throw new Error('Сервис вернул неполный маршрут. Оценка времени не показана.');
        data.legs.forEach((leg,i)=>legs.push({...leg,from:start+i,to:start+i+1}));
        data.locations.forEach((p,i)=>{locations[start+i]=p});
      }
      if(locations.length!==stages.length||locations.some(p=>!point(p)))throw new Error('Не удалось определить все адреса маршрута. Уточните город и адреса.');
      const seconds=legs.reduce((sum,leg)=>sum+leg.seconds,0);
      if(!finite(seconds)||seconds<0)throw new Error('Сервис не вернул время маршрута.');
      return {legs,locations,seconds,mode,calculatedAt:Date.now()};
    }
    requestChunk(ymaps,referencePoints,mode) {
      return new Promise((resolve,reject)=>{
        let model,settled=false;
        const timer=setTimeout(()=>finish(new Error('Сервис не ответил за 25 секунд. Возможно, не подключена маршрутизация/геокодер или исчерпан бесплатный лимит.')),25000);
        const success=event=>{
          try {
            if(settled)return;
            if(event?.get('rough'))return;
            const route=model.getRoutes()[0];if(!route)throw new Error('Маршрут не найден. Проверьте адреса и выбранный транспорт.');
            const legs=[],locations=[];
            route.getPaths().forEach(path=>{
              const seconds=(mode==='auto'?path.properties.get('durationInTraffic'):null)?.value??path.properties.get('duration')?.value;
              let coordinates=path.properties.get('coordinates');if(!coordinates)coordinates=path.geometry?.getCoordinates?.();
              if(!finite(seconds)||seconds<0||!Array.isArray(coordinates)||coordinates.length<1||!coordinates.every(point))throw new Error('Сервис вернул неполные данные пути.');
              legs.push({coordinates:coordinates.map(p=>p.slice()),seconds});
            });
            model.getWayPoints().forEach(p=>locations.push(p.geometry.getCoordinates().slice()));
            finish(null,{legs,locations});
          }catch(error){finish(error)}
        };
        const failure=event=>{
          const error=event.get('error');
          finish(new Error('Не удалось построить маршрут. Проверьте доступ ключа к маршрутизации и геокодеру, домен и лимиты.'+(error?.message?' '+error.message:'')));
        };
        function finish(error,data) {
          if(settled)return;settled=true;clearTimeout(timer);
          if(model){model.events.remove('requestsuccess',success);model.events.remove('requestfail',failure);try{model.destroy()}catch(_){}}
          error?reject(error):resolve(data);
        }
        try {
          model=new ymaps.multiRouter.MultiRouteModel(referencePoints,{routingMode:mode,results:1});
          model.events.add('requestsuccess',success);model.events.add('requestfail',failure);
        }catch(error){finish(error)}
      });
    }
    paint(data) {
      if(!data||!this.map||this.root.hidden)return;
      const ymaps=window.ymaps,stages=this.stages;this.clearMap();
      data.legs.forEach(leg=>{
        // A leg is completed only when both endpoint stops are marked completed.
        const done=Boolean(stages[leg.from]?.done&&stages[leg.to]?.done);
        if(leg.coordinates.length>1)this.map.geoObjects.add(new ymaps.Polyline(leg.coordinates,{}, {strokeColor:done?'#0874fa':'#8299b5',strokeWidth:4,strokeStyle:done?'solid':'dash',interactivityModel:'default#silent'}));
      });
      const groups=new Map();data.locations.forEach((location,i)=>{const k=keyOf(location);if(!groups.has(k))groups.set(k,{location,stops:[]});groups.get(k).stops.push(stages[i])});
      groups.forEach(({location,stops})=>{
        const done=stops.every(s=>s.done),number=stops.map(s=>s.number).join('/');
        this.map.geoObjects.add(new ymaps.Placemark(location,{iconContent:number},{preset:'islands#blueCircleIcon',iconColor:done?'#0874fa':'#8299b5',interactivityModel:'default#silent'}));
      });
      const bounds=this.map.geoObjects.getBounds();
      if(bounds){const promise=this.map.setBounds(bounds,{checkZoomRange:true,zoomMargin:[25,30,45,30],duration:0});promise?.catch?.(()=>{});}
      this.map.container.fitToViewport();this.overlay.hidden=true;this.root.dataset.state='ready';this.loadedSignature=this.signature;
      this.eta.textContent='≈ '+timeText(data.seconds)+' на весь маршрут';
      this.caption.textContent=MODES[data.mode]+' · с возвращением домой, без вручения и перерывов';
      this.detail.hidden=false;this.detail.textContent='Расчёт по текущим условиям Яндекса, не GPS-трек.';this.retry.hidden=false;
    }
  }
  window.CourierDayMap={DayMap};
})();
