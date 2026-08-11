# Pagos y facturación

## Medios de pago aceptados
- Tarjetas de crédito Visa, Mastercard y American Express.
- Tarjetas de débito Visa Débito y Maestro.
- Transferencia bancaria.
- Pago en efectivo en puntos de cobro adheridos (vence a las 72 horas de generado).

## Cuotas
Las promociones de cuotas sin interés dependen del banco emisor y se muestran al momento del pago. No se pueden aplicar de forma retroactiva sobre una compra ya realizada.

## Acreditación
- Tarjetas: la acreditación es inmediata salvo que el pago quede en revisión antifraude, lo que puede demorar hasta 24 horas.
- Transferencia: se acredita dentro de las 48 horas hábiles de recibido el comprobante.
- Efectivo: entre 24 y 72 horas hábiles según el punto de cobro.

## Cobros duplicados
Si el cliente ve dos cargos por la misma compra, en la mayoría de los casos se trata de una preautorización que se libera sola en un plazo de 7 a 10 días hábiles. Si pasado ese plazo el cargo sigue, se abre un reclamo con motivo `cobro_incorrecto` y se gestiona la devolución con el banco.

## Facturación
La factura electrónica se emite dentro de las 24 horas de acreditado el pago y se envía al correo registrado. Para facturar a nombre de una empresa, los datos fiscales deben cargarse **antes** de finalizar la compra: no se pueden modificar después de emitida la factura.

## Cancelaciones
Un pedido puede cancelarse sin costo mientras esté en estado `pendiente_pago` o `en_preparacion`. Una vez despachado, se gestiona como devolución según la política correspondiente.
