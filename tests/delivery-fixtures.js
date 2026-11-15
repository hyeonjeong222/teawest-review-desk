import {deliveryPlatforms} from '../public/platforms.js';
export const emptyDeliveryConnectors = () => Object.fromEntries(Object.entries(deliveryPlatforms).map(([platform,config])=>[platform,{
 status:async()=>({connected:false}),sync:async period=>({reviews:[],total:0,store:config.brand,period}),
 publish:()=>{throw new Error('Unexpected publication');},
}]));
